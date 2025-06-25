import { Client, connect, IClientOptions, IClientPublishOptions } from "mqtt";
import Service, { Message } from "webos-service";

interface ForegroundAppInfo {
  windowId: string;
  appId: string;
  mediaId: string;
  type: string;
  playState: string;
}

interface ForegroundAppIdResponse {
  subscribed: boolean;
  foregroundAppInfo: ForegroundAppInfo[];
  returnValue: boolean;
}

interface AppState {
  play: string;
  app: string;
  type: string;
}

export interface LgTvMqttConfig {
  host: string; // Your MQTT broker host
  port: number; // Your MQTT broker port, default 1883
  username: string; // Your MQTT username
  password: string; // Your MQTT password
  deviceID: string; // This should be unique across the MQTT network. If you're using this on multiple TVs, update this
}

class Logging {
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

export class LgTvMqtt {
  private logging = new Logging();
  private client: Client;
  private mqttConfig: IClientOptions;
  private connectUrl: string;
  private keepAlive: Record<string, any> = {};
  private wasConnected = false;
  private foregroundAppState: AppState = { play: "idle", app: "unknown", type: "unknown" };
  private topicAutoDiscoveryPlayState: string;
  private topicAutoDiscoveryAppId: string;
  private topicAutoDiscoveryType: string;
  private topicAvailability: string;
  private topicState: string;
  private playStateConfig: string;
  private appIdConfig: string;
  private typeConfig: string;
  private publishOptionRetain: IClientPublishOptions = { qos: 0, retain: true };
  private publishOptionNoRetain: IClientPublishOptions = { qos: 0, retain: false };
  constructor(private service: Service, private config: LgTvMqttConfig) {
    this.connectUrl = `mqtt://${this.config.host}:${this.config.port}`;
    this.topicAutoDiscoveryPlayState = `homeassistant/sensor/${this.config.deviceID}/playState/config`;
    this.topicAutoDiscoveryAppId = `homeassistant/sensor/${this.config.deviceID}/appId/config`;
    this.topicAutoDiscoveryType = `homeassistant/sensor/${this.config.deviceID}/type/config`;
    this.topicAvailability = `LGTV2MQTT/${this.config.deviceID}/availability`;
    this.topicState = `LGTV2MQTT/${this.config.deviceID}/state`;
    this.mqttConfig = {
      username: this.config.username,
      password: this.config.password,
      keepalive: 180, // automatically checks for connection, closing if no response for 3 minutes
      connectTimeout: 10000, // 10 seconds
      reconnectPeriod: 3000, // 3 seconds
      // reconnectOnConnackError: true, // TODO: only available on MQTT v5+ which does not work with webOS SDK 6, find another way
      will: {
        topic: this.topicAvailability,
        payload: "offline",
        retain: false,
        qos: 0,
      },
    };
    this.playStateConfig = JSON.stringify(this.createAutoDiscoveryConfig("mdi:play-pause", "play", "Play State"));
    this.appIdConfig = JSON.stringify(this.createAutoDiscoveryConfig("mdi:apps", "app", "Application ID"));
    this.typeConfig = JSON.stringify(this.createAutoDiscoveryConfig("mdi:import", "type", "Discovery Type"));
    this.foregroundAppState = this.createState("idle", "unknown", "unknown");
    this.logging.log("Starting the LGTV MQTT connection service");
    this.service.activityManager.create("keepAlive", (activity) => {
      this.keepAlive = activity;
    });
    this.logging.log("Service set to maintain the connection in the background");
    this.logging.log("Connecting to the MQTT server");
    this.client = connect(this.connectUrl, this.mqttConfig);
    this.client.on("connect", () => this.handleConnect());
    this.client.on("close", () => this.logging.log("WARNING - MQTT server disconnected, attempting to reconnect"));
    this.client.on("error", (error: Error | undefined) => this.logging.log("ERROR - MQTT connection error:", error));
  }

  private handleConnect() {
    try {
      if (!this.wasConnected) {
        this.logging.log("Successfully connected to the MQTT server");
        this.publishAutoDiscovery();
        this.publishAppState();
        this.publishAvailability();
        this.logging.log("Subscribing to media service for foreground app state updates");
        this.service
          .subscribe("luna://com.webos.media/getForegroundAppInfo", {
            subscribe: true,
          })
          .on("response", (message: Message) =>
            this.handleForegroundAppResponse(message.payload as ForegroundAppIdResponse)
          );
        this.logging.log("Service started successfully, reporting media state via MQTT");
        this.wasConnected = true;
      } else {
        this.logging.log("Reconnected to the MQTT server");
        this.publishAppState();
        this.publishAvailability();
      }
    } catch (error) {
      this.logging.log("ERROR - LGTV MQTT service connected then failed due to error:", error);
    }
  }

  private handleForegroundAppResponse(response: ForegroundAppIdResponse) {
    if (!this.client.connected) {
      this.logging.log("WARNING - MQTT connection lost, unable to publish media state");
      return;
    }
    if (
      response &&
      response.foregroundAppInfo &&
      Array.isArray(response.foregroundAppInfo) &&
      response.foregroundAppInfo.length > 0
    ) {
      const info: ForegroundAppInfo = response.foregroundAppInfo[0];
      this.foregroundAppState = this.createState(info.playState, info.appId, info.type);
      this.publishAppState();
    } else {
      // TODO: test why this is needed and when it occurs, should we just ignore?
      this.logging.log("WARNING - Unexpected foreground app update:", response);
      this.foregroundAppState = this.createState("idle", "unknown", "unknown");
      this.client.publish(this.topicState, JSON.stringify(this.foregroundAppState), this.publishOptionNoRetain);
    }
    this.publishAvailability();
  }

  private publishAutoDiscovery() {
    this.logging.log("Sending Home Assistant auto-discovery configs");
    try {
      const discoveryConfig = [
        { topic: this.topicAutoDiscoveryPlayState, config: this.playStateConfig },
        { topic: this.topicAutoDiscoveryAppId, config: this.appIdConfig },
        { topic: this.topicAutoDiscoveryType, config: this.typeConfig },
      ];
      discoveryConfig.forEach(({ topic, config }) => {
        this.client.publish(topic, config, this.publishOptionRetain, (error: Error | undefined) =>
          this.handlePublishError(error, topic)
        );
      });
    } catch (error) {
      this.logging.log("ERROR - Failed to send Home Assistant auto-discovery configs:", error);
      throw error;
    }
  }

  private publishAppState() {
    this.logging.log("Sending TV's foreground app state:", this.foregroundAppState);
    try {
      this.client.publish(
        this.topicState,
        JSON.stringify(this.foregroundAppState),
        this.publishOptionNoRetain,
        (error: Error | undefined) => this.handlePublishError(error, this.topicState)
      );
    } catch (error) {
      this.logging.log("ERROR - Failed to send TV state:", error);
      throw error;
    }
  }

  private publishAvailability() {
    this.logging.log("Sending notification of availability");
    try {
      this.client.publish(this.topicAvailability, "online", this.publishOptionRetain, (error: Error | undefined) =>
        this.handlePublishError(error, this.topicAvailability)
      );
    } catch (error) {
      this.logging.log("ERROR - Failed to notify of availability:", error);
      throw error;
    }
  }

  private handlePublishError(error: Error | undefined, topicName: string) {
    if (error) {
      this.logging.log(`ERROR - Failed to send to ${topicName}:`, error);
    }
  }

  private createAutoDiscoveryConfig(icon: string, id: string, name: string) {
    return {
      icon: `${icon}`,
      "~": `LGTV2MQTT/${this.config.deviceID}/`,
      availability_topic: `${this.topicAvailability}`,
      state_topic: `${this.topicState}`,
      name: `${name}`,
      unique_id: `${this.config.deviceID}_${id}`,
      payload_available: "online",
      payload_not_available: "offline",
      value_template: `{{ value_json.${id}}}`,
      device: {
        identifiers: `${this.config.deviceID}`,
        name: `${this.config.deviceID}`,
        manufacturer: "LG",
      },
    };
  }

  private createState(play: string, app: string, type: string): AppState {
    return { play, app, type };
  }

  getConnectionState(message: Message) {
    message.respond({ connected: this.client.connected });
  }

  getLogs(message: Message) {
    message.respond({ logs: this.logging.getLogs() });
  }
}
