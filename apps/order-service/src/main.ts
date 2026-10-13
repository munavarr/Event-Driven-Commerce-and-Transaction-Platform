import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { Transport, MicroserviceOptions } from '@nestjs/microservices';
import { AppModule, ObserveInstrument } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    AppModule,
    {
      instrument: ObserveInstrument,
      transport: Transport.GRPC,
      options: {
        package: 'commerce',
        protoPath: join(
          process.cwd(),
          '../../libs/contracts/proto/commerce.proto',
        ),
        url: '127.0.0.1:50051',
      },
    },
  );

  await app.listen();
  console.log('Order Service gRPC listening on 127.0.0.1:50051');
}

void bootstrap();
