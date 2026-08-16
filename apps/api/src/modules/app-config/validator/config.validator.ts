import Joi from 'joi';

export const validateConfigOrThrowError = (yamlConfig: Record<string, any>) => {
  const configValidationSchema = Joi.object({
    environment: Joi.string().required().valid('dev', 'prod', 'test', 'uat'),
    port: Joi.number().required().positive(),

    app_settings: Joi.object({
      app_name: Joi.string().required(),
      app_url: Joi.string().required(),
      api: Joi.object({
        api_key: Joi.string().required(),
        api_secret: Joi.string().required(),
      }),
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

    openai: Joi.object({
      api_key: Joi.string().required(),
      debug: Joi.boolean().default(false),
    }).required(),

    gemini: Joi.object({
      api_key: Joi.string()
        .min(1)
        .required()
        .messages({ 'string.min': 'API key should be set when using the Gemini API.' }),
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

    exa: Joi.object({
      api_key: Joi.string().required(),
      api_url: Joi.string().optional(),
    }).required(),

    supabase: Joi.object({
      url: Joi.string().required(),
      api_key: Joi.string().required(),
    }).required(),

    bunny: Joi.object({
      url: Joi.string().required(),
      api_key: Joi.string().required(),
      cdn_url: Joi.string().required(),
    }).required(),

    dataforseo: Joi.object({
      api_url: Joi.string().required(),
      email: Joi.string().required(),
      password: Joi.string().required(),
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

    mailgun: Joi.object({
      api_key: Joi.string().required(),
      domain: Joi.string().required(),
      api_url: Joi.string().optional(),
    }).required(),

    recaptcha: Joi.object({
      secret_key: Joi.string().required(),
      min_score: Joi.number().min(0).max(1).optional(),
    }).required(),
  }).required();

  const result = configValidationSchema.validate(yamlConfig, {
    abortEarly: false,
  });

  if (result.error) {
    throw Error(result.error.message);
  }
};
