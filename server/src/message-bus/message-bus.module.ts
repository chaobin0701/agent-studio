import { Global, Module } from '@nestjs/common';
import { InMemoryMessageBus } from './in-memory-message-bus';

@Global()
@Module({ providers: [InMemoryMessageBus], exports: [InMemoryMessageBus] })
export class MessageBusModule {}
