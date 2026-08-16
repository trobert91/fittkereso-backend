import Joi from 'joi';

export const validateConfigOrThrowError = (yamlConfig: Record<string, any>) => {
  const configValidationSchema = Joi.object({
    environment: Joi.string().required().valid('dev', 'prod', 'test', 'uat'),
    port: Joi.number().required().positive(),
    service_type: Joi.string()
      .required()
      .valid('webserver', 'worker', 'scheduler-worker'),

    app_settings: Joi.object({
      app_name: Joi.string().required(),
      app_url: Joi.string().required(),
      api: Joi.object({
        api_key: Joi.string().required(),
        api_secret: Joi.string().required(),
      }),
    }).required(),

    task: Joi.object({
      max_attempts: Joi.number().required().positive(),
      process_comments_parallel: Joi.boolean().required(),
    }).required(),

    mongo: Joi.object({
      url: Joi.string().required(),
    }).required(),

    postgres: Joi.object({
      host: Joi.string().required(),
      port: Joi.number().required(),
      user: Joi.string().required(),
      password: Joi.string().required(),
      database: Joi.string().required(),
      sync: Joi.boolean().required(),
      run_migrations: Joi.boolean().required(),
      ssl: Joi.boolean().required(),
      logging: Joi.boolean().required(),
    }).required(),

    reddit: Joi.object({
      client_id: Joi.string().required(),
      client_secret: Joi.string().required(),
      user_agent: Joi.string().required(),
      refresh_token: Joi.string().required(),
      username: Joi.string(),
      password: Joi.string(),
    }).required(),

    openai: Joi.object({
      api_key: Joi.string().required(),
      debug: Joi.boolean().default(false),
    }).required(),

    gemini: Joi.object({
      api_key: Joi.string().allow('').required(),
      debug: Joi.boolean().default(false),
    }).required(),

    claude: Joi.object({
      api_key: Joi.string().allow('').required(),
      debug: Joi.boolean().default(false),
    }).required(),

    openrouter: Joi.object({
      api_key: Joi.string().allow('').required(),
      debug: Joi.boolean().default(false),
    }).required(),

    deepseek: Joi.object({
      api_key: Joi.string().allow('').required(),
      debug: Joi.boolean().default(false),
    }).required(),

    dataforseo: Joi.object({
      api_url: Joi.string().required(),
      email: Joi.string().required(),
      password: Joi.string().required(),
    }).required(),

    exa: Joi.object({
      api_key: Joi.string().required(),
      api_url: Joi.string().optional(),
    }).required(),

    logging: Joi.object({
      app_name: Joi.string().required(),
      environment: Joi.string().required(),
      url: Joi.string().required(),
      username: Joi.string().optional(),
      password: Joi.string().optional(),
      token: Joi.string().optional(),
      level: Joi.string().optional(),
    }).required(),

    zyte: Joi.object({
      api_url: Joi.string().required(),
      api_key: Joi.string().required(),
    }).required(),

    bunny: Joi.object({
      url: Joi.string().required(),
      api_key: Joi.string().required(),
      cdn_url: Joi.string().required(),
    }).required(),
  }).required();

  const result = configValidationSchema.validate(yamlConfig, {
    abortEarly: false,
  });

  if (result.error) {
    throw Error(result.error.message);
  }
};
