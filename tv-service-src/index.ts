import Service from "webos-service";
import { StateReporter, MQTTConfig } from "./state-reporter";
import mqttConfigRaw from "./mqtt-config.json";
const mqttConfig: MQTTConfig = mqttConfigRaw;
const service = new Service("com.danvnest.applauncherandstatereporter.service");
const stateReporter = new StateReporter(service, mqttConfig);
service.register("getConnectionState", (message) => stateReporter.getConnectionState(message));
service.register("getLogs", (message) => stateReporter.getLogs(message));
