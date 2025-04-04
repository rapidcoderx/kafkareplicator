require('dotenv').config();
const axios = require('axios');
const { Kafka } = require('kafkajs');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const cron = require('node-cron');
const logger = require('./utils/logger');

const argv = yargs(hideBin(process.argv))
  .option('interval', {
    alias: 'i',
    description: 'Polling interval in milliseconds',
    type: 'number',
    default: process.env.POLLING_INTERVAL || 1000
  })
  .help()
  .alias('help', 'h')
  .argv;

// Kafka configuration for local instance
const kafka = new Kafka({
  clientId: process.env.KAFKA_CLIENT_ID || 'kafka-replicator-client',
  brokers: ['localhost:9092'],
  retry: {
    initialRetryTime: parseInt(process.env.KAFKA_RETRY_INITIAL) || 100,
    retries: parseInt(process.env.KAFKA_RETRY_RETRIES) || 10,
    maxRetryTime: parseInt(process.env.KAFKA_RETRY_MAX) || 1000,
    factor: parseFloat(process.env.KAFKA_RETRY_FACTOR) || 2,
    multiplier: parseFloat(process.env.KAFKA_RETRY_MULTIPLIER) || 1.5
  }
});

const producer = kafka.producer();

// Initialize Kafka producer
async function initKafkaProducer() {
  try {
    await producer.connect();
    logger.info('Connected to local Kafka');
  } catch (error) {
    logger.error('Error connecting to local Kafka:', error);
    process.exit(1);
  }
}

// Poll server for events and push to local Kafka
async function pollAndPushEvents() {
  try {
    const response = await axios.get(process.env.SERVER_URL + '/api/v1/events', {
      headers: {
        'x-api-key': process.env.API_KEY
      }
    });

    const eventsByTopic = response.data;
    if (eventsByTopic && Object.keys(eventsByTopic).length > 0) {
      for (const [topic, events] of Object.entries(eventsByTopic)) {
        if (events && events.length > 0) {
          try {
            await producer.send({
              topic,
              messages: events.map(event => ({
                value: event.value
              }))
            });
            logger.info(`Pushed ${events.length} events to local Kafka topic: ${topic}`);
          } catch (error) {
            logger.error(`Error pushing events to local Kafka topic ${topic}:`, error);
          }
        }
      }
    }
  } catch (error) {
    logger.error('Error polling server:', error.message);
  }
}

// Graceful shutdown
async function gracefulShutdown() {
  logger.info('Initiating graceful shutdown...');
  try {
    await producer.disconnect();
    logger.info('Graceful shutdown completed');
  } catch (error) {
    logger.error('Error during graceful shutdown:', error);
    process.exit(1);
  }
}

// Handle process termination
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, starting graceful shutdown');
  await gracefulShutdown();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, starting graceful shutdown');
  await gracefulShutdown();
  process.exit(0);
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

// Main function
async function main() {
  try {
    await initKafkaProducer();
    
    // Start polling using node-cron
    const cronExpression = `*/${Math.floor(argv.interval / 1000)} * * * * *`;
    cron.schedule(cronExpression, async () => {
      await pollAndPushEvents();
    });
    
    logger.info(`Started polling server every ${argv.interval}ms`);
  } catch (error) {
    logger.error('Error in main function:', error);
    process.exit(1);
  }
}

main().catch(error => {
  logger.error('Fatal error:', error);
  process.exit(1);
}); 