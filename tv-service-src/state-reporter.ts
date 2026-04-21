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
  private stateTopic: string;
  private availabilityTopic: string;
  private publishOptions: IClientPublishOptions = { qos: 0, retain: true };
  constructor(private service: Service, mqttConfig: MQTTConfig) {
    this.logger.log("Starting the TV state reporting service");
    try {
      // var activitySpec = {
      //   activity: {
      //     name: "tv-state-reporter",
      //     description: "Monitors for TV state changes and reports to Home Assistant",
      //     type: { foreground: true },
      //   },
      //   start: true,
      //   replace: true,
      // };
      this.service.activityManager.create("tv-state-reporter", (activity) => {
        this.logger.log("Service set to maintain the connection in the background");
      });
      // this.service.call("luna://com.palm.activitymanager/create", activitySpec, (reply) => {
      //   this.logger.log("Activity manager reply:", reply); // TODO: remove
      //   this.logger.log("Service set to run in the background of all apps");
      // });
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
        this.publishState("unknown");
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
        this.publishState("unknown");
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

  private publishState(state: string, app?: string) {
    this.logger.log(
      "Sending TV's media state" +
        (app && app !== "unknown" && app !== "unavailable" ? ` for app '${app}'` : "") +
        `: '${state}'`
    );
    try {
      this.client.publish(this.stateTopic, state, this.publishOptions, (error: Error | undefined) =>
        this.handlePublishError(error, this.stateTopic)
      );
    } catch (error) {
      this.logger.log("ERROR - Failed to send TV's media state:", error);
      throw error;
    }
  }

  private publishAvailability() {
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
      this.publishState(response.foregroundAppInfo[0].playState, response.foregroundAppInfo[0].appId);
    } else if (response?.subscribed && response?.returnValue && response?.foregroundAppInfo.length === 0) {
      // can happen when going to home screen, but also when an app exits a show or changes to a different section, ignore
    } else if ("subscription" in response) {
      // foreground app provides this if the subscription status updates, ignore
    } else {
      this.logger.log("WARNING - Unexpected foreground app update:", response); // TODO: monitor this over time, handle different updates instead of warning
      this.publishState("unknown");
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
