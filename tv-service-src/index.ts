import Service from "webos-service";
import { StateReporter, MQTTConfig } from "./state-reporter";

const service = new Service("com.danvnest.applauncherandstatereporter.service");
const mqttConfig: MQTTConfig = {
  host: "YOUR MQTT BROKER HOST",
  port: 1883,
  username: "YOUR MQTT USERNAME",
  password: "YOUR MQTT PASSWORD",
  deviceID: "TV",
};
const stateReporter = new StateReporter(service, mqttConfig);
service.register("getConnectionState", (message) => stateReporter.getConnectionState(message));
service.register("getLogs", (message) => stateReporter.getLogs(message));
