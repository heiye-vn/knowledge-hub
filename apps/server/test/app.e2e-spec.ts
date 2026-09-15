import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';

describe('AppController (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/ (GET) 应当返回统一格式的成功响应', async () => {
    const res = await request(app.getHttpServer()).get('/').expect(200);

    expect(res.body).toMatchObject({
      code: 200,
      message: 'success',
      data: 'Hello World!',
    });
    expect(res.body).toHaveProperty('timestamp');
  });

  it('/not-found (GET) 应当返回统一格式的 404 异常响应', async () => {
    const res = await request(app.getHttpServer())
      .get('/not-found-path')
      .expect(404);

    expect(res.body).toMatchObject({
      code: 404,
      message: 'Cannot GET /not-found-path',
      error: 'Not Found',
    });
    expect(res.body).toHaveProperty('timestamp');
    expect(res.body).toHaveProperty('path', '/not-found-path');
  });

  afterEach(async () => {
    await app.close();
  });
});
