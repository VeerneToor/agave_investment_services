import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Client } from 'whatsapp-web.js';
import * as terminalQr from 'qrcode-terminal';
import { OpenAI } from 'openai';
import admin from 'firebase-admin';
import { databaseConfig } from './Globals/databaseConfid';

@Injectable()
export class AppService implements OnModuleInit {
  private;
  get db(): admin.firestore.Firestore {
    if (!admin.apps.length) {
      const { firestore } = admin.initializeApp({
        credential: admin.credential.cert({
          clientEmail: databaseConfig.client_email,
          privateKey: databaseConfig.private_key,
          projectId: databaseConfig.project_id,
        }),
        databaseURL: `https://${databaseConfig.project_id}.firebaseio.com`,
      });

      return firestore();
    }

    return admin.firestore();
  }

  get iaClient(): OpenAI {
    const iaClient = new OpenAI({
      apiKey: process.env['OPENAI_API_KEY'],
    });

    return iaClient;
  }

  private delayerMessages: { [key: string]: Array<string> } = {};
  private delayerPromises: { [key: string]: (state: boolean) => void } = {};

  private async delayerHandler(fromId: string) {
    return new Promise<boolean>(async (resolve) => {
      if (!this.delayerPromises[fromId]) {
        this.delayerPromises[fromId] = resolve;
      } else {
        this.delayerPromises[fromId](false);
      }

      setTimeout(() => {
        this.delayerPromises[fromId](true);
      }, 6000);
    });
  }

  async onModuleInit() {
    const whatsAppClient = new Client({
      puppeteer: {
        args: ['--no-sandbox'],
      },
    });

    whatsAppClient.on('qr', (qr) => {
      Logger.debug('QR RECEIVED', 'AppService');
      terminalQr.generate(qr, { small: true });
    });

    whatsAppClient.on('ready', () => {
      console.log('whatsAppClient is ready!');
    });

    whatsAppClient.on('message', async (msg) => {
      if (!this.delayerMessages[msg.from]) {
        this.delayerMessages[msg.from] = [];
      }

      this.delayerMessages[msg.from].push(msg.body);

      if (!(await this.delayerHandler(msg.from))) {
        return;
      }

      msg.body = this.delayerMessages[msg.from].join('\n');

      if (msg.isEphemeral || msg.hasMedia) {
        return whatsAppClient.sendMessage(
          msg.from,
          '😶‍🌫️😶‍🌫️ Lo siento 😶‍🌫️😶‍🌫️, aún no puedo ver multimedia ni mensajes efimeros...',
        );
      }

      await this.addMessageToChatContext(msg.from, {
        role: 'user',
        message: msg.body,
      });

      const chatContext = await this.getChatContext(msg.from);

      let thread = await this.iaClient.beta.threads
        .retrieve(chatContext.threadId ?? msg.from)
        .catch(() => null);

      if (!thread) {
        thread = await this.iaClient.beta.threads.create({
          messages: [
            {
              role: 'user',
              content: msg.body,
            },
          ],
        });
        this.saveThreadId(msg.from, thread.id);
      } else {
        await this.iaClient.beta.threads.messages.create(thread.id, {
          role: 'user',
          content: msg.body,
        });
      }

      const run = await this.iaClient.beta.threads.runs.create(thread.id, {
        assistant_id: process.env['ASSISTANT_ID'],
      });

      this.getThreadStatus(thread.id, run.id, async () => {
        const threadMessages = await this.iaClient.beta.threads.messages.list(
          thread.id,
        );

        whatsAppClient.sendMessage(
          msg.from,
          threadMessages.data[0].content[0][
            threadMessages.data[0].content[0].type
          ].value,
        );

        this.addMessageToChatContext(msg.from, {
          role: 'system',
          message:
            threadMessages.data[0].content[0][
              threadMessages.data[0].content[0].type
            ].value,
        });
      });
    });

    whatsAppClient.initialize();
  }

  private saveThreadId(fromId: string, threadId: string) {
    return this.db
      .collection('bot_interactions')
      .doc(fromId)
      .set({ threadId }, { merge: true });
  }

  private async getChatContext(
    fromId: string,
  ): Promise<{ [key: string]: any }> {
    return this.db
      .collection('bot_interactions')
      .doc(fromId)
      .get()
      .then((response) => response.data());
  }

  private addMessageToChatContext(
    fromId: string,
    message: {
      role: 'user' | 'system';
      message: string;
    },
  ) {
    return this.db
      .collection('bot_interactions')
      .doc(fromId)
      .set(
        {
          messages: admin.firestore.FieldValue.arrayUnion(message),
        },
        { merge: true },
      );
  }

  private async getThreadStatus(
    threadId: string,
    runId: string,
    cb: (status: boolean) => void,
  ) {
    while (true) {
      const threadRun = await this.iaClient.beta.threads.runs.retrieve(
        threadId,
        runId,
      );

      if (threadRun.status === 'completed') {
        cb(true);
        break;
      }

      if (threadRun.status === 'failed') {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        break;
      }
    }
  }

  getHello(): string {
    return 'Hello World!';
  }
}
