import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Global, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppConfigService } from '../dist/config/config.service.js';
import { InteractionModule } from '../dist/interactions/interaction.module.js';
import { InteractionService } from '../dist/interactions/interaction.service.js';
import { SecurityRateLimitService } from '../dist/security/security-rate-limit.service.js';

test('the real interaction module resolves its database provider during Nest application creation',async()=>{
  class FixtureConfiguration {}
  Global()(FixtureConfiguration);
  Module({providers:[SecurityRateLimitService,{provide:AppConfigService,useValue:{
    databaseUrl:'postgres://unused:unused@127.0.0.1:1/unused',
    jwt:{secret:'offline-module-resolution-secret-at-least-32-bytes',issuer:'fixture',audience:'fixture',expiresInSeconds:60},
  }}],exports:[AppConfigService,SecurityRateLimitService]})(FixtureConfiguration);
  class Fixture {}
  Module({imports:[FixtureConfiguration,InteractionModule]})(Fixture);
  // Creating the real module graph catches missing imports. Do not initialize
  // the app or open a database connection; this is dependency resolution only.
  const app=await NestFactory.create(Fixture,{logger:false,abortOnError:false});
  try { assert.ok(app.get(InteractionService) instanceof InteractionService); }
  finally { await app.close(); }
});
