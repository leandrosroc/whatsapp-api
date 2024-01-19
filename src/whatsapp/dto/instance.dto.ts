export class InstanceDto {
  instanceName: string;
  instanceId?: string;
  qrcode?: boolean;
  number?: string;
  token?: string;
  webhook?: string;
  webhook_by_events?: boolean;
  webhook_base64?: boolean;
  events?: string[];
  reject_call?: boolean;
  msg_call?: string;
  groups_ignore?: boolean;
  always_online?: boolean;
  read_messages?: boolean;
  read_status?: boolean;
  websocket_enabled?: boolean;
  websocket_events?: string[];
  rabbitmq_enabled?: boolean;
  rabbitmq_events?: string[];
  proxy?: string;
}
