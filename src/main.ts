import { INestApplication, NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.setGlobalPrefix('v1');
  setupOpenApi(app);
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();

function setupOpenApi(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle('PasaTanda PayBE API')
    .setDescription(
      'Internal Vault endpoints for sponsoring gas, relaying transactions, and fiat automation.',
    )
    .setVersion('1.0.0')
    .addServer('http://localhost:3000', 'Local')
    .addSecurity('internal-api-key', {
      type: 'apiKey',
      in: 'header',
      name: 'x-internal-api-key',
      description: 'Shared secret between AgentBE and PayBE.',
    })
    .addSecurityRequirements('internal-api-key')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);
}
