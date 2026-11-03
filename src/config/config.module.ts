import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AppConfig } from './app-config';
import { Env, envSchema, validateEnvOrExit } from './env.schema';

/**
 * Wraps @nestjs/config with Zod validation and exposes a typed AppConfig.
 * .env is loaded once in loadConfigOrExit(), so the env file is ignored here.
 */
@Global()
@Module({
  imports: [ConfigModule.forRoot({ ignoreEnvFile: true, cache: true, validate: validateEnvOrExit })],
  providers: [
    {
      provide: AppConfig,
      inject: [ConfigService],
      useFactory: (cs: ConfigService<Env, true>): AppConfig => {
        const keys = Object.keys(envSchema.shape) as (keyof Env)[];
        const env = Object.fromEntries(keys.map((k) => [k, cs.get(k, { infer: true })])) as Env;
        return new AppConfig(env);
      },
    },
  ],
  exports: [AppConfig],
})
export class AppConfigModule {}
