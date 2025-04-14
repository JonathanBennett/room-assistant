import { WinstonModule } from 'nest-winston';
import winston from 'winston';
import { TransformableInfo } from 'logform';
import c from 'config';
import { LoggerConfig } from './config/logger.config';
import * as TransportStream from 'winston-transport';

const config = c.get<LoggerConfig>('logger');
const instanceName = c.get<string>('global.instanceName');
const missingDeps: string[] = [];

const transports: TransportStream[] = [
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.timestamp(),
      process.stdout.isTTY
        ? winston.format.colorize()
        : winston.format.uncolorize(),
      winston.format.printf((info: TransformableInfo) => {
        return `${new Date(info.timestamp as string).toLocaleString()} - ${
          info.level
        } - ${info.context}: ${info.message}`;
      })
    ),
  }),
];

// Use an IIAFE to handle async imports for optional transports
(async () => {
  if (config.elasticsearch.enabled) {
    try {
      const { ElasticsearchTransport } = await import('winston-elasticsearch'); // Use dynamic import

      transports.push(
        new ElasticsearchTransport({
          indexPrefix: config.elasticsearch.indexPrefix,
          clientOpts: {
            node: config.elasticsearch.node,
            auth: config.elasticsearch.auth,
          },
        })
      );
    } catch (e) {
      missingDeps.push('elasticsearch');
    }
  }

  if (config.loki.enabled) {
    const lokiFormatter = winston.format(
      (
        info: TransformableInfo & {
          instanceName?: string;
          labels?: Record<string, string>;
        }
      ) => {
        info.labels = info.labels || {};
        info.labels.context = info.context as string;
        info.labels.instanceName = info.instanceName as string;
        return info;
      }
    );

    try {
      const LokiTransport = await import('winston-loki'); // Use dynamic import

      transports.push(
        new LokiTransport.default({
          // Access default export if needed
          host: config.loki.host,
          labels: {
            job: 'room-assistant',
          },
          format: winston.format.combine(
            lokiFormatter(),
            winston.format.printf((info) => `${info.message}`)
          ),
          gracefulShutdown: false,
          clearOnError: true,
        })
      );
    } catch (e) {
      missingDeps.push('loki');
    }
  }

  // Log missing dependencies after attempting to load them
  missingDeps.forEach((dep) => {
    WINSTON_LOGGER.error(
      `Logging with ${dep} was enabled, but the dependency is missing. Please install it with "npm install -g winston-${dep}".`,
      null,
      'LoggerService'
    );
  });
})(); // Immediately invoke the async function

export const WINSTON_LOGGER = WinstonModule.createLogger({
  level: process.env.NODE_LOG_LEVEL || 'info',
  defaultMeta: {
    instanceName,
  },
  transports, // Transports array might be populated asynchronously
});

// Note: Logging missing deps here might happen before the async IIAFE completes.
// Moved the logging inside the IIAFE for correctness.
