import { Client, connect, IClientOptions, IClientPublishOptions } from "mqtt";
import Service, { Message } from "webos-service";

enum ServiceState {
  STARTED = "STARTED",
  FAILED_TO_PUBLISH_CONFIGS = "FAILED TO PUBLISH CONFIGS",
  FAILED_TO_PUBLISH_INITIAL_STATE = "FAILED TO PUBLISH INITIAL STATE",
  FAILED_TO_SET_ONLINE = "FAILED TO SET ONLINE",
  FAILED_TO_START = "FAILED TO START",
  STOPPED = "STOPPED",
}

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
  log(...s: any[]) {
    this.logs.unshift(`${new Date().toISOString()} - ${JSON.stringify(s)}`);
  }
  getLogs() {
    return this.logs;
  }
}

export class LgTvMqtt {
  constructor(private service: Service, private config: LgTvMqttConfig) {}
  private state: ServiceState = ServiceState.STOPPED;
  private logging = new Logging();
  private keepAlive: Record<string, any> = {};
  private client: Client | undefined;
  private clientId = `mqtt_${Math.random().toString(16).slice(3)}`;
  private connectUrl = `mqtt://${this.config.host}:${this.config.port}`;
  private topicAutoDiscoveryPlayState = `homeassistant/sensor/${this.config.deviceID}/playState/config`;
  private topicAutoDiscoveryAppId = `homeassistant/sensor/${this.config.deviceID}/appId/config`;
  private topicAutoDiscoveryType = `homeassistant/sensor/${this.config.deviceID}/type/config`;
  private topicAvailability = `LGTV2MQTT/${this.config.deviceID}/availability`;
  private topicState = `LGTV2MQTT/${this.config.deviceID}/state`;
  private mqttConfig: IClientOptions = {
    clientId: this.clientId,
    clean: true,
    connectTimeout: 4000,
    keepalive: 180, // 3 minutes
    username: this.config.username,
    password: this.config.password,
    reconnectPeriod: 10000, // 10 seconds
    will: {
      topic: this.topicAvailability,
      payload: "offline",
      retain: false,
      qos: 0,
    },
  };

  private playStateConfig = JSON.stringify(this.createAutoDiscoveryConfig("mdi:play-pause", "play", "Play State"));
  private appIdConfig = JSON.stringify(this.createAutoDiscoveryConfig("mdi:apps", "app", "Application ID"));
  private typeConfig = JSON.stringify(this.createAutoDiscoveryConfig("mdi:import", "type", "Discovery Type")); // TODO: Do we need discovery type?
  private publishOptionRetain: IClientPublishOptions = { qos: 0, retain: true };
  private publishOptionNoRetain: IClientPublishOptions = { qos: 0, retain: false };

  start(message: Message) {
    if (this.state === ServiceState.STARTED) {
      return;
    }
    try {
      this.logging.log("Starting the LGTV MQTT connection service");
      this.service.activityManager.create("keepAlive", (activity) => {
        this.keepAlive = activity;
      });
      this.logging.log("Service set to maintain the connection in the background");
      this.logging.log(
        `Connecting to the MQTT server with the following settings:\n${JSON.stringify(this.mqttConfig)}`
      );
      this.client = connect(this.connectUrl, this.mqttConfig);
      this.logging.log("Successfully connected to the MQTT server");
      this.sendAutoDiscovery(message);
      this.publishInitialState(message);
      this.publishAvailability(message);
      this.logging.log("Subscribing to media service");
      this.service
        .subscribe("luna://com.webos.media/getForegroundAppInfo", {
          subscribe: true,
        })
        .on("response", (message: Message) =>
          this.handleForegroundAppResponse(message, message.payload as ForegroundAppIdResponse)
        );
      this.logging.log("Service started successfully - reporting media state via MQTT");
      message.respond({ started: true });
      this.state = ServiceState.STARTED;
    } catch (error) {
      this.logging.log(`Failed to start LGTV MQTT connection service:\n${JSON.stringify(error)}`);
      this.logging.log("Service will attemp to start again in 10 seconds");
      message.respond({ started: false });
      this.state = ServiceState.FAILED_TO_START;
      setTimeout(() => this.start(message), 10000);
    }
  }

  getState(message: Message) {
    message.respond({ state: this.state });
  }

  getLogs(message: Message) {
    message.respond({ logs: this.logging.getLogs() });
  }

  private handleForegroundAppResponse(message: Message, payload: ForegroundAppIdResponse) {
    if (
      payload &&
      payload.foregroundAppInfo &&
      Array.isArray(payload.foregroundAppInfo) &&
      payload.foregroundAppInfo.length > 0
    ) {
      this.logging.log(`Sending foreground app state update:\n${JSON.stringify(payload)}`);
      const info: ForegroundAppInfo = payload.foregroundAppInfo[0];
      const state = this.createState(info.playState, info.appId, info.type);
      this.client?.publish(this.topicState, JSON.stringify(state), this.publishOptionNoRetain);
    } else {
      // TODO: test why this is needed and when it occurs, should we just ignore?
      this.logging.log(`WARNING: Unexpected foreground app update:\n${JSON.stringify(message)}`);
      this.client?.publish(
        this.topicState,
        JSON.stringify(this.createState("idle", "unknown", "unknown")),
        this.publishOptionNoRetain
      );
    }
    this.publishAvailability(message);
  }

  private sendAutoDiscovery(message: Message) {
    this.logging.log("Sending Home Assistant auto-discovery configs");
    try {
      const discoveryConfig = [
        { topic: this.topicAutoDiscoveryPlayState, config: this.playStateConfig },
        { topic: this.topicAutoDiscoveryAppId, config: this.appIdConfig },
        { topic: this.topicAutoDiscoveryType, config: this.typeConfig },
      ];
      discoveryConfig.forEach(({ topic, config }) => {
        this.client?.publish(topic, config, this.publishOptionRetain, (error) => this.handlePublishEnd(error, topic));
      });
      this.logging.log("Does this show before or after 'Published successfully to...'?");
    } catch (error) {
      this.logging.log(`Failed to publish Home Assistant auto-discovery configs, error:\n${JSON.stringify(error)}`);
      message.respond({ started: false });
      this.state = ServiceState.FAILED_TO_PUBLISH_CONFIGS;
      throw error;
    }
  }

  private publishInitialState(message: Message) {
    this.logging.log("Sending initial TV state");
    try {
      this.client?.publish(
        this.topicState,
        JSON.stringify(this.createState("idle", "unknown", "unknown")),
        this.publishOptionNoRetain,
        (error) => this.handlePublishEnd(error, this.topicState)
      );
      this.logging.log("Does this show before or after 'Published successfully to...'?");
    } catch (error) {
      this.logging.log(`Failed to send initial TV state, error:\n${JSON.stringify(error)}`);
      message.respond({ started: false });
      this.state = ServiceState.FAILED_TO_PUBLISH_INITIAL_STATE;
      throw error;
    }
  }

  private publishAvailability(message: Message) {
    this.logging.log("Sending notification of availability");
    try {
      this.client?.publish(this.topicAvailability, "online", this.publishOptionRetain, (error) =>
        this.handlePublishEnd(error, this.topicAvailability)
      );
      this.logging.log("Does this show before or after 'Published successfully to...'?");
    } catch (error) {
      this.logging.log(`Failed to notify of availability, error:\n${JSON.stringify(error)}`);
      message.respond({ started: false });
      this.state = ServiceState.FAILED_TO_SET_ONLINE;
      throw error;
    }
  }

  private handlePublishEnd(error: Error | undefined, topicName: string) {
    if (error) {
      this.logging.log(`An error occurred during publish to ${topicName}`, `${JSON.stringify(error)}`);
    } else {
      this.logging.log(`Published successfully to ${topicName}`);
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
}
