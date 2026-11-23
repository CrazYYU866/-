import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConnectedSocket, MessageBody, type OnGatewayConnection, type OnGatewayInit, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Namespace, Server, Socket } from 'socket.io';
import type { AccessTokenPayload } from '../auth/session.service';
import { SessionService } from '../auth/session.service';
import { OrderCore } from '../orders/order-core';

/**
 * События в реальном времени (ТЗ §18: WebSocket): уведомления, новое предложение, сообщения чата, движение техники.
 * Подключение: socket.io на /ws, токен доступа в auth.token. Комнаты: user:{id} и order:{id} (только участникам заказа).
 */
@WebSocketGateway({ namespace: '/ws', cors: { origin: true } })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayInit {
  private readonly logger = new Logger(RealtimeGateway.name);
  @WebSocketServer() server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly sessions: SessionService,
    private readonly core: OrderCore,
  ) {}

  /**
   * Проверка токена — до установки соединения (middleware Socket.IO): клиент получает «connect» только
   * после успешной проверки, поэтому подписка сразу после подключения не теряется (раньше была гонка).
   */
  afterInit(server: Namespace): void {
    server.use((socket, next) => {
      const token = String((socket.handshake.auth as { token?: string } | undefined)?.token ?? '');
      this.jwt
        .verifyAsync<AccessTokenPayload>(token)
        .then(async (payload) => {
          if ((await this.sessions.isActive(payload.sid, payload.sub)) !== 'ok') throw new Error('session');
          socket.data['userId'] = payload.sub;
          next();
        })
        .catch(() => next(new Error('unauthorized')));
    });
  }

  async handleConnection(client: Socket): Promise<void> {
    const userId = client.data['userId'] as string | undefined;
    if (!userId) {
      client.disconnect(true);
      return;
    }
    await client.join(`user:${userId}`);
  }

  @SubscribeMessage('subscribe_order')
  async subscribeOrder(@ConnectedSocket() client: Socket, @MessageBody() body: { orderId?: string }): Promise<{ ok: boolean }> {
    const userId = client.data['userId'] as string | undefined;
    if (!userId || !body?.orderId) return { ok: false };
    try {
      const p = await this.core.participant(body.orderId, userId);
      if (!p.customer && !p.operator && !p.staffRole) return { ok: false };
      await client.join(`order:${body.orderId}`);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  toUser(userId: string, event: string, data: unknown): void {
    this.server?.to(`user:${userId}`).emit(event, data);
  }

  toOrder(orderId: string, event: string, data: unknown): void {
    this.server?.to(`order:${orderId}`).emit(event, data);
  }
}
