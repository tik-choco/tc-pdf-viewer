import { MistNode } from '../lib/mistlib/index.js';
import { readDeviceId } from './device.js';

const deviceId = readDeviceId();
const sysNode = new MistNode(deviceId);

export async function getMistNode() {
  await sysNode.init();
  return sysNode;
}
