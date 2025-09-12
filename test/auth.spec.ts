import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Auth (e2e-light scaffolds)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => { await app.close(); });

  it('signup -> me', async () => {
    const agent = request.agent(app.getHttpServer());
    const email = `user${Date.now()}@test.com`;
    await agent.post('/auth/signup').send({ email, password: 'password123' }).expect(201);
    const me = await agent.get('/auth/me').expect(200);
    expect(me.body.email).toBe(email);
  });

  it('login -> refresh -> me', async () => {
    const agent = request.agent(app.getHttpServer());
    await agent.post('/auth/login').send({ email: 'admin@test.com', password: 'password' }).expect(200);
    await agent.post('/auth/refresh').expect(200);
    await agent.get('/auth/me').expect(200);
  });
});


