require('dotenv').config();
const express = require('express');
const promClient = require('prom-client');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const asyncHandler = require('express-async-handler');
const logger = require('./utils/logger');
const KafkaManager = require('./utils/kafkaManager');

const app = express();
const port = process.env.PORT || 3000;
const apiPrefix = process.env.API_PREFIX || '/api/v1';

// Security middleware
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
  methods: ['GET'],
  allowedHeaders: ['x-api-key', 'Content-Type']
}));

// Compression
app.use(compression());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// Prometheus metrics
const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

// Custom metrics
const kafkaEventsConsumed = new promClient.Counter({
  name: 'kafka_events_consumed_total',
  help: 'Total number of events consumed from Kafka',
  registers: [register],
  labelNames: ['topic']
});

const apiRequestsTotal = new promClient.Counter({
  name: 'api_requests_total',
  help: 'Total number of requests to the /events endpoint',
  registers: [register],
});

const kafkaErrorsTotal = new promClient.Counter({
  name: 'kafka_errors_total',
  help: 'Total number of Kafka-related errors',
  registers: [register],
  labelNames: ['topic']
});

// Swagger configuration
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Kafka Replicator API',
      version: '1.0.0',
      description: 'API for replicating Kafka events',
    },
    servers: [
      {
        url: `http://localhost:${port}${apiPrefix}`,
        description: 'Development server',
      },
    ],
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'x-api-key',
        },
      },
    },
  },
  apis: ['./src/index.js'],
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);

// In-memory event storage
const eventStore = new Map();

// Standardize event structure
function standardizeEvent(event) {
  return {
    value: event.value,
    timestamp: event.timestamp,
    topic: event.topic,
    partition: event.partition,
    offset: event.offset
  };
}

// Middleware for API key authentication
const apiKeyMiddleware = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== process.env.API_KEY) {
    logger.warn('Unauthorized access attempt');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// Initialize Kafka manager
const kafkaManager = new KafkaManager({
  clientId: 'kafka-replicator-server',
  brokers: [process.env.KAFKA_BROKER || 'kafka-service.namespace.svc.cluster.local:9092'],
  topics: process.env.KAFKA_TOPICS ? process.env.KAFKA_TOPICS.split(',') : ['your-topic-name'],
  groupId: 'kafka-replicator-group'
});

// Handle Kafka messages
async function handleMessage(event) {
  try {
    if (!eventStore.has(event.topic)) {
      eventStore.set(event.topic, []);
    }

    const events = eventStore.get(event.topic);
    const standardizedEvent = standardizeEvent(event);
    events.unshift(standardizedEvent);
    
    const maxEvents = parseInt(process.env.MAX_EVENTS_PER_TOPIC) || 10;
    if (events.length > maxEvents) {
      events.pop();
    }

    kafkaEventsConsumed.inc({ topic: event.topic });
    logger.info(`Received event from topic ${event.topic}:`, standardizedEvent);
  } catch (error) {
    logger.error(`Error handling message from topic ${event.topic}:`, error);
    kafkaErrorsTotal.inc({ topic: event.topic });
  }
}

// Routes
/**
 * @swagger
 * /events:
 *   get:
 *     summary: Get latest Kafka events
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: topic
 *         schema:
 *           type: string
 *         description: Filter events by topic
 *     responses:
 *       200:
 *         description: List of latest events
 *       401:
 *         description: Unauthorized
 */
app.get(`${apiPrefix}/events`, apiKeyMiddleware, asyncHandler(async (req, res) => {
  apiRequestsTotal.inc();
  const topic = req.query.topic;
  
  if (topic) {
    if (!eventStore.has(topic)) {
      return res.json([]);
    }
    return res.json(eventStore.get(topic));
  }

  const allEvents = {};
  for (const [topic, events] of eventStore) {
    allEvents[topic] = events;
  }
  res.json(allEvents);
}));

/**
 * @swagger
 * /metrics:
 *   get:
 *     summary: Get Prometheus metrics
 *     responses:
 *       200:
 *         description: Prometheus metrics
 */
app.get(`${apiPrefix}/metrics`, asyncHandler(async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
}));

// Swagger documentation
app.use(`${apiPrefix}/docs`, swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Health check endpoint
app.get(`${apiPrefix}/health`, (req, res) => {
  res.json({ 
    status: 'ok',
    kafka: kafkaManager.consumers.size > 0 ? 'connected' : 'disconnected'
  });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, starting graceful shutdown');
  await kafkaManager.gracefulShutdown();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, starting graceful shutdown');
  await kafkaManager.gracefulShutdown();
  process.exit(0);
});

// Start the server
const server = app.listen(port, '0.0.0.0', async () => {
  logger.info(`Server running on port ${port}`);
  logger.info(`API documentation available at http://localhost:${port}${apiPrefix}/docs`);
  
  try {
    await kafkaManager.connect();
    await kafkaManager.startConsuming(handleMessage);
  } catch (error) {
    logger.error('Failed to start Kafka consumer:', error);
    process.exit(1);
  }
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
}); 