import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  // Enable CORS for frontend communication
  app.enableCors({
    origin: [
      'http://localhost:3000', 
      'http://localhost:3001',
      'http://192.168.0.190:3000',  // Allow access from your IP
      'http://192.168.0.190:3001'
    ],
    credentials: true,
  });
  
  // Enable validation pipes
  app.useGlobalPipes(new ValidationPipe());
  
  await app.listen(process.env.PORT ?? 3001);
  console.log('🚀 Porridge API server running on http://localhost:3001');
}
bootstrap();
