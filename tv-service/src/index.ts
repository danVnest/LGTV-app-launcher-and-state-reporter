import Service from "webos-service";
import { LgTvMqtt, LgTvMqttConfig } from "./lgtv-mqtt";

const service = new Service("com.danvnest.applauncher+mqtt.service");
const config: LgTvMqttConfig = {
  host: "YOUR MQTT BROKER HOST",
  port: 1883,
  username: "YOUR MQTT USERNAME",
  password: "YOUR MQTT PASSWORD",
  deviceID: "webOSTVService",
};

const lgTvMqtt = new LgTvMqtt(service, config);
service.register("start", (message) => lgTvMqtt.start(message));
service.register("getState", (message) => lgTvMqtt.getState(message));
service.register("getLogs", (message) => lgTvMqtt.getLogs(message));
