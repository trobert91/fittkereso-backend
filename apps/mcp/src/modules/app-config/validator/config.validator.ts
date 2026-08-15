import Joi from 'joi';

export const validateConfigOrThrowError = (yamlConfig: Record<string, any>) => {
  const configValidationSchema = Joi.object({
    environment: Joi.string().required().valid('dev', 'prod', 'test', 'uat'),
    port: Joi.number().required().positive(),

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

    logging: Joi.object({
      app_name: Joi.string().required(),
      environment: Joi.string().required(),
      url: Joi.string().required(),
      username: Joi.string().optional(),
      password: Joi.string().optional(),
      token: Joi.string().optional(),
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

    zyte: Joi.object({
      api_url: Joi.string().required(),
      api_key: Joi.string().required(),
    }).required(),
  }).required();

  const result = configValidationSchema.validate(yamlConfig, {
    abortEarly: false,
  });

  if (result.error) {
    throw Error(result.error.message);
  }
};
