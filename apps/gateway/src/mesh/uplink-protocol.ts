export {
  KEY_LOG_PAGE_DEFAULT_LIMIT,
  KEY_LOG_PAGE_MAX_BYTES,
  KEY_LOG_PAGE_MAX_LIMIT,
  UPLINK_CTL_MAX_ARRAY_LEN,
  UPLINK_CTL_MAX_BYTES,
  UPLINK_CTL_MAX_CERT_BYTES,
  UPLINK_CTL_MAX_DEPTH,
  UPLINK_CTL_MAX_STRING_LEN,
  UPLINK_CTL_TYPES,
  decodeMeshUplinkCtl as decodeUplinkCtl,
  encodeMeshUplinkCtl as encodeUplinkCtl,
  type MeshUplinkCtlMessage as UplinkCtlMessage,
  type MeshUplinkEnrollRedeemed as UplinkEnrollRedeemed,
  type MeshUplinkKeyLogAck as UplinkKeyLogAck,
  type MeshUplinkKeyLogRecord as UplinkKeyLogRecord,
  type MeshUplinkNodeList as UplinkNodeList,
  type MeshUplinkRtcSignal as UplinkRtcSignal,
} from '@tmex/shared/uplink';

export function uplinkWsUrl(hubUrl: string): string {
  const url = new URL(hubUrl);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  url.pathname = '/hub/uplink';
  url.search = '';
  url.hash = '';
  return url.toString();
}
