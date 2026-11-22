import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConnectedSocket, MessageBody, type OnGatewayConnection, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import type { AccessTokenPayload } from '../auth/session.service';
import { SessionService } from '../auth/session.service';
import { OrderCore } from '../orders/order-core';

/**
 * События в реальном времени (ТЗ §18: WebSocket): уведомления, новое предложение, сообщения чата, движение техники.
 * Подключение: socket.io на /ws, токен доступа в auth.token. Комнаты: user:{id} и order:{id} (только участникам заказа).
 */
@WebSocketGateway({ namespace: '/ws', cors: { origin: true } })
export class RealtimeGateway implements OnGatewayConnection {
  private readonly logger = new Logger(RealtimeGateway.name);
  @WebSocketServer() server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly sessions: SessionService,
    private readonly core: OrderCore,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    try {
      const token = String((client.handshake.auth as { token?: string } | undefined)?.token ?? '');
      const payload = await this.jwt.verifyAsync<AccessTokenPayload>(token);
      if ((await this.sessions.isActive(payload.sid, payload.sub)) !== 'ok') throw new Error('session');
      client.data['userId'] = payload.sub;
      await client.join(`user:${payload.sub}`);
    } catch {
      client.disconnect(true);
    }
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
