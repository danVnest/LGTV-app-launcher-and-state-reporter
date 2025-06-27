import { Client, connect, IClientOptions, IClientPublishOptions } from "mqtt";
import Service, { Message } from "webos-service";

export interface MQTTConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  deviceID: string; // if multiple TVs, each should have a unique ID
}

interface ForegroundAppInfo {
  windowId: string;
  appId: string;
  mediaId: string;
  type: string;
  playState: string;
}

interface ForegroundAppResponse {
  subscribed: boolean;
  foregroundAppInfo: ForegroundAppInfo[];
  returnValue: boolean;
}

class Logger {
  private logs: string[] = [];
  log(log: string, ...extraLogContent: any[]) {
    if (extraLogContent.length > 0) {
      const shortExtraLogContent = JSON.stringify(extraLogContent);
      if (shortExtraLogContent.length < 100) {
        log += ` ${shortExtraLogContent}`;
      } else {
        log += `\n${JSON.stringify(extraLogContent, null, "\t")}\n`;
      }
    }
    this.logs.push(`${new Date().toLocaleString()} - ${log}`);
  }
  getLogs() {
    return this.logs;
  }
}

export class StateReporter {
  private logger = new Logger();
  private client: Client;
  private deviceID: string;
  private wasConnected = false;
  private state: string = "idle";
  private stateTopic: string;
  private availabilityTopic: string;
  private publishOptions: IClientPublishOptions = { qos: 0, retain: true };
  constructor(private service: Service, mqttConfig: MQTTConfig) {
    this.logger.log("Starting the TV state reporting service");
    try {
      this.service.activityManager.create("tv-state-reporter", (activity) => {
        this.logger.log("Service set to maintain the connection in the background");
      });
    } catch (error) {
      this.logger.log("ERROR - Failed to set service to run in the background of all apps:", error);
    }
    this.logger.log("Connecting to the Home Assistant MQTT server");
    this.deviceID = mqttConfig.deviceID;
    this.stateTopic = `stateReporter/${this.deviceID}/state`;
    this.availabilityTopic = `stateReporter/${this.deviceID}/availability`;
    let connectUrl: string = `mqtt://${mqttConfig.host}:${mqttConfig.port}`;
    let clientConfig: IClientOptions = {
      username: mqttConfig.username,
      password: mqttConfig.password,
      keepalive: 180, // automatically checks for connection, closing if no response for 3 minutes
      connectTimeout: 10000, // 10 seconds
      reconnectPeriod: 3000, // 3 seconds
      // reconnectOnConnackError: true, // TODO: only available on MQTT v5+ which does not work with webOS SDK 6, find another way
      will: {
        topic: this.availabilityTopic,
        payload: "offline",
        retain: false,
        qos: 0,
      },
    };
    this.client = connect(connectUrl, clientConfig);
    this.client.on("connect", () => this.handleConnect());
    this.client.on("close", () =>
      this.logger.log("WARNING - Home Assistant MQTT server disconnected, automatically attempting to reconnect")
    );
    this.client.on("error", (error: Error | undefined) =>
      this.logger.log("ERROR - Home Assistant MQTT connection error:", error)
    );
  }

  private handleConnect() {
    try {
      if (!this.wasConnected) {
        this.logger.log("Successfully connected to the Home Assistant MQTT server");
        this.publishAutoDiscovery();
        this.publishState();
        this.publishAvailability();
        this.logger.log("Subscribing to media service for foreground app state updates");
        this.service
          .subscribe("luna://com.webos.media/getForegroundAppInfo", {
            subscribe: true,
          })
          .on("response", (message: Message) =>
            this.handleForegroundAppResponse(message.payload as ForegroundAppResponse)
          );
        this.logger.log("Service started successfully, reporting media state to Home Assistant");
        this.wasConnected = true;
      } else {
        this.logger.log("Reconnected to the Home Assistant MQTT server");
        this.publishState();
        this.publishAvailability();
      }
    } catch (error) {
      this.logger.log("ERROR - Service connected successfully, then failed due to error:", error);
    }
  }

  private publishAutoDiscovery() {
    this.logger.log("Sending Home Assistant sensor auto-discovery configs");
    try {
      let topic = `homeassistant/sensor/${this.deviceID}/state/config`;
      this.client.publish(
        topic,
        JSON.stringify({
          "~": `stateReporter/${this.deviceID}/`,
          name: "State",
          unique_id: `${this.deviceID}_state`,
          value_template: "{{ value }}",
          state_topic: `${this.stateTopic}`,
          availability_topic: `${this.availabilityTopic}`,
          icon: "mdi:play-pause",
          device: {
            identifiers: `${this.deviceID}`,
            name: `${this.deviceID}`,
            manufacturer: "LG",
            model: `${this.deviceID}`,
          },
        }),
        this.publishOptions,
        (error: Error | undefined) => this.handlePublishError(error, topic)
      );
    } catch (error) {
      this.logger.log("ERROR - Failed to send Home Assistant sensor auto-discovery configs:", error);
      throw error;
    }
  }

  private publishState() {
    this.logger.log(`Sending TV's media state: '${this.state}'`);
    try {
      this.client.publish(this.stateTopic, this.state, this.publishOptions, (error: Error | undefined) =>
        this.handlePublishError(error, this.stateTopic)
      );
    } catch (error) {
      this.logger.log("ERROR - Failed to send TV's media state:", error);
      throw error;
    }
  }

  private publishAvailability() {
    this.logger.log("Sending notification of availability");
    try {
      this.client.publish(this.availabilityTopic, "online", this.publishOptions, (error: Error | undefined) =>
        this.handlePublishError(error, this.availabilityTopic)
      );
    } catch (error) {
      this.logger.log("ERROR - Failed to notify of availability:", error);
      throw error;
    }
  }

  private handlePublishError(error: Error | undefined, topicName: string) {
    if (error) {
      this.logger.log(`ERROR - Failed to send to ${topicName}:`, error);
    }
  }

  private handleForegroundAppResponse(response: ForegroundAppResponse) {
    if (!this.client.connected) {
      this.logger.log("WARNING - MQTT connection lost, unable to publish media state");
      return;
    }
    if (response?.foregroundAppInfo?.[0]?.playState) {
      this.state = response.foregroundAppInfo[0].playState;
      this.publishState();
    } else {
      this.logger.log("WARNING - Unexpected foreground app update:", response); // TODO: monitor this over time, handle different updates instead of warning
      this.state = "idle";
      this.publishState();
    }
    this.publishAvailability();
  }

  getConnectionState(message: Message) {
    message.respond({ connected: this.client.connected });
  }

  getLogs(message: Message) {
    message.respond({ logs: this.logger.getLogs() });
  }
}
