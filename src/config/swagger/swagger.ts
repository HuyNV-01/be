import { DocumentBuilder } from '@nestjs/swagger';

export const config = new DocumentBuilder()
  .setTitle('webAPI')
  .setDescription('The cats API description')
  .setVersion('1.0')
  .addBearerAuth(
    {
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
      name: 'Authorization',
      description: 'Enter JWT token',
      in: 'header',
    },
    'access-token',
  )
  .addBearerAuth(
    {
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
      name: 'Authorization',
      description: 'Enter Refresh Token',
      in: 'header',
    },
    'refresh-token',
  )
  .build();

export const documentFactory = () => config;

export const SWAGGER_PATH = 'api/docs';

export const SWAGGER_CONFIG = {
  path: SWAGGER_PATH,
  documentBuilder: documentFactory,
};
