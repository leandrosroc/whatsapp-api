import { delay } from '@whiskeysockets/baileys';
import { isURL } from 'class-validator';
import EventEmitter2 from 'eventemitter2';
import { v4 } from 'uuid';

import { ConfigService } from '../../config/env.config';
import { Logger } from '../../config/logger.config';
import { BadRequestException, InternalServerErrorException } from '../../exceptions';
import { InstanceDto } from '../dto/instance.dto';
import { RepositoryBroker } from '../repository/repository.manager';
import { AuthService, OldToken } from '../services/auth.service';
import { WAMonitoringService } from '../services/monitor.service';
import { RabbitmqService } from '../services/rabbitmq.service';
import { SettingsService } from '../services/settings.service';
import { WebhookService } from '../services/webhook.service';
import { WebsocketService } from '../services/websocket.service';
import { WAStartupService } from '../services/whatsapp.service';
import { Events, wa } from '../types/wa.types';

export class InstanceController {
  constructor(
    private readonly waMonitor: WAMonitoringService,
    private readonly configService: ConfigService,
    private readonly repository: RepositoryBroker,
    private readonly eventEmitter: EventEmitter2,
    private readonly authService: AuthService,
    private readonly webhookService: WebhookService,
    private readonly settingsService: SettingsService,
    private readonly websocketService: WebsocketService,
    private readonly rabbitmqService: RabbitmqService,
  ) {}

  private readonly eventsDefault: string[] = [
    'APPLICATION_STARTUP',
    'QRCODE_UPDATED',
    'MESSAGES_SET',
    'MESSAGES_UPSERT',
    'MESSAGES_UPDATE',
    'MESSAGES_DELETE',
    'SEND_MESSAGE',
    'CONTACTS_SET',
    'CONTACTS_UPSERT',
    'CONTACTS_UPDATE',
    'PRESENCE_UPDATE',
    'CHATS_SET',
    'CHATS_UPSERT',
    'CHATS_UPDATE',
    'CHATS_DELETE',
    'GROUPS_UPSERT',
    'GROUP_UPDATE',
    'GROUP_PARTICIPANTS_UPDATE',
    'CONNECTION_UPDATE',
    'CALL',
    'NEW_JWT_TOKEN',
  ];

  private readonly logger = new Logger(InstanceController.name);

  public async createInstance({
    instanceName,
    webhook,
    webhook_by_events,
    webhook_base64,
    events,
    qrcode,
    number,
    token,
    reject_call,
    msg_call,
    groups_ignore,
    always_online,
    read_messages,
    read_status,
    websocket_enabled,
    websocket_events,
    rabbitmq_enabled,
    rabbitmq_events,
  }: InstanceDto) {
    try {
      this.logger.verbose('requested createInstance from ' + instanceName + ' instance');

      this.logger.verbose('checking duplicate token');
      await this.authService.checkDuplicateToken(token);

      this.logger.verbose('creating instance');
      const instance = new WAStartupService(this.configService, this.eventEmitter, this.repository);
      instance.instanceName = instanceName;

      const instanceId = v4();

      instance.sendDataWebhook(Events.INSTANCE_CREATE, {
        instanceName,
        instanceId: instanceId,
      });

      this.logger.verbose('instance: ' + instance.instanceName + ' created');

      this.waMonitor.waInstances[instance.instanceName] = instance;
      this.waMonitor.delInstanceTime(instance.instanceName);

      this.logger.verbose('generating hash');
      const hash = await this.authService.generateHash(
        {
          instanceName: instance.instanceName,
          instanceId: instanceId,
        },
        token,
      );

      this.logger.verbose('hash: ' + hash + ' generated');

      let webhookEvents: string[];

      if (webhook) {
        if (!isURL(webhook, { require_tld: false })) {
          throw new BadRequestException('Invalid "url" property in webhook');
        }

        this.logger.verbose('creating webhook');
        try {
          const newEvents: string[] = events.length === 0 ? this.eventsDefault : events;
          this.webhookService.create(instance, {
            enabled: true,
            url: webhook,
            events: newEvents,
            webhook_by_events,
            webhook_base64,
          });

          webhookEvents = (await this.webhookService.find(instance)).events;
        } catch (error) {
          this.logger.error(error);
        }
      }

      let websocketEvents: string[];

      if (websocket_enabled) {
        this.logger.verbose('creating websocket');
        try {
          const newEvents: string[] = events.length === 0 ? this.eventsDefault : websocket_events;
          this.websocketService.create(instance, {
            enabled: true,
            events: newEvents,
          });

          websocketEvents = (await this.websocketService.find(instance)).events;
        } catch (error) {
          this.logger.error(error);
        }
      }

      let rabbitmqEvents: string[];

      if (rabbitmq_enabled) {
        this.logger.verbose('creating rabbitmq');
        try {
          const newEvents: string[] = events.length === 0 ? this.eventsDefault : rabbitmq_events;
          this.rabbitmqService.create(instance, {
            enabled: true,
            events: newEvents,
          });

          rabbitmqEvents = (await this.rabbitmqService.find(instance)).events;
        } catch (error) {
          this.logger.error(error);
        }
      }

      this.logger.verbose('creating settings');
      const settings: wa.LocalSettings = {
        reject_call: reject_call || false,
        msg_call: msg_call || '',
        groups_ignore: groups_ignore || true,
        always_online: always_online || false,
        read_messages: read_messages || false,
        read_status: read_status || false,
      };

      this.logger.verbose('settings: ' + JSON.stringify(settings));

      this.settingsService.create(instance, settings);

      let getQrcode: wa.QrCode;

      if (qrcode) {
        this.logger.verbose('creating qrcode');
        await instance.connectToWhatsapp(number);
        await delay(5000);
        getQrcode = instance.qrCode;
      }
      const result = {
        instance: {
          instanceName: instance.instanceName,
          instanceId: instanceId,
          status: 'created',
        },
        hash,
        webhook: {
          webhook,
          webhook_by_events,
          webhook_base64,
          events: webhookEvents,
        },
        websocket: {
          enabled: websocket_enabled,
          events: websocketEvents,
        },
        rabbitmq: {
          enabled: rabbitmq_enabled,
          events: rabbitmqEvents,
        },
        settings,
        qrcode: getQrcode,
      };
      this.logger.verbose('instance created');
      this.logger.verbose(result);
      return result;
    } catch (error) {
      this.logger.error(error.message[0]);
      throw new BadRequestException(error.message[0]);
    }
  }

  public async connectToWhatsapp({ instanceName, number = null }: InstanceDto) {
    try {
      this.logger.verbose('requested connectToWhatsapp from ' + instanceName + ' instance');

      const instance = this.waMonitor.waInstances[instanceName];
      const state = instance?.connectionStatus?.state;

      this.logger.verbose('state: ' + state);

      if (!state) {
        throw new BadRequestException('The "' + instanceName + '" instance does not exist');
      }

      if (state == 'open') {
        return await this.connectionState({ instanceName });
      }

      if (state == 'connecting') {
        return instance.qrCode;
      }

      if (state == 'close') {
        this.logger.verbose('connecting');
        await instance.connectToWhatsapp(number);

        await delay(5000);
        return instance.qrCode;
      }

      return {
        instance: {
          instanceName: instanceName,
          status: state,
        },
        qrcode: instance?.qrCode,
      };
    } catch (error) {
      this.logger.error(error);
    }
  }

  public async restartInstance({ instanceName }: InstanceDto) {
    try {
      this.logger.verbose('requested restartInstance from ' + instanceName + ' instance');

      const instance = this.waMonitor.waInstances[instanceName];
      const state = instance?.connectionStatus?.state;

      switch (state) {
        case 'open':
          this.logger.verbose('logging out instance: ' + instanceName);
          await instance.reloadConnection();
          await delay(2000);

          return await this.connectionState({ instanceName });
        default:
          return await this.connectionState({ instanceName });
      }
    } catch (error) {
      this.logger.error(error);
    }
  }

  public async connectionState({ instanceName }: InstanceDto) {
    this.logger.verbose('requested connectionState from ' + instanceName + ' instance');
    return {
      instance: {
        instanceName: instanceName,
        state: this.waMonitor.waInstances[instanceName]?.connectionStatus?.state,
      },
    };
  }

  public async fetchInstances({ instanceName, instanceId }: InstanceDto) {
    if (instanceName) {
      this.logger.verbose('requested fetchInstances from ' + instanceName + ' instance');
      this.logger.verbose('instanceName: ' + instanceName);
      return this.waMonitor.instanceInfo(instanceName);
    } else if (instanceId) {
      return this.waMonitor.instanceInfoById(instanceId);
    }

    this.logger.verbose('requested fetchInstances (all instances)');
    return this.waMonitor.instanceInfo();
  }

  public async logout({ instanceName }: InstanceDto) {
    this.logger.verbose('requested logout from ' + instanceName + ' instance');
    const { instance } = await this.connectionState({ instanceName });

    if (instance.state === 'close') {
      throw new BadRequestException('The "' + instanceName + '" instance is not connected');
    }

    try {
      this.logger.verbose('logging out instance: ' + instanceName);
      await this.waMonitor.waInstances[instanceName]?.client?.logout('Log out instance: ' + instanceName);

      this.logger.verbose('close connection instance: ' + instanceName);
      this.waMonitor.waInstances[instanceName]?.client?.ws?.close();

      return { status: 'SUCCESS', error: false, response: { message: 'Instance logged out' } };
    } catch (error) {
      throw new InternalServerErrorException(error.toString());
    }
  }

  public async deleteInstance({ instanceName }: InstanceDto) {
    this.logger.verbose('requested deleteInstance from ' + instanceName + ' instance');
    const { instance } = await this.connectionState({ instanceName });

    if (instance.state === 'open') {
      throw new BadRequestException('The "' + instanceName + '" instance needs to be disconnected');
    }
    try {
      this.waMonitor.waInstances[instanceName]?.removeRabbitmqQueues();

      if (instance.state === 'connecting') {
        this.logger.verbose('logging out instance: ' + instanceName);

        await this.logout({ instanceName });
      }

      this.logger.verbose('deleting instance: ' + instanceName);

      try {
        this.waMonitor.waInstances[instanceName].sendDataWebhook(Events.INSTANCE_DELETE, {
          instanceName,
          instanceId: (await this.repository.auth.find(instanceName))?.instanceId,
        });
      } catch (error) {
        this.logger.error(error);
      }

      delete this.waMonitor.waInstances[instanceName];
      this.eventEmitter.emit('remove.instance', instanceName, 'inner');
      return { status: 'SUCCESS', error: false, response: { message: 'Instance deleted' } };
    } catch (error) {
      throw new BadRequestException(error.toString());
    }
  }

  public async refreshToken(_: InstanceDto, oldToken: OldToken) {
    this.logger.verbose('requested refreshToken');
    return await this.authService.refreshToken(oldToken);
  }
}
