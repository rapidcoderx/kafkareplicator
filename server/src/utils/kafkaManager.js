const { Kafka } = require('kafkajs');
const logger = require('./logger');

class KafkaManager {
  constructor(config) {
    this.kafka = new Kafka({
      clientId: config.clientId,
      brokers: config.brokers,
      retry: {
        initialRetryTime: 100,
        retries: 10,
        maxRetryTime: 1000,
        factor: 2,
        multiplier: 1.5
      }
    });
    this.consumers = new Map();
    this.topics = config.topics || [];
    this.groupId = config.groupId;
  }

  async connect() {
    try {
      for (const topic of this.topics) {
        const consumer = this.kafka.consumer({ 
          groupId: `${this.groupId}-${topic}`,
          heartbeatInterval: 3000,
          sessionTimeout: 10000,
          rebalanceTimeout: 30000
        });

        await consumer.connect();
        await consumer.subscribe({ 
          topic,
          fromBeginning: false 
        });

        this.consumers.set(topic, consumer);
        logger.info(`Connected to Kafka and subscribed to topic: ${topic}`);
      }
    } catch (error) {
      logger.error('Error connecting to Kafka:', error);
      throw error;
    }
  }

  async startConsuming(callback) {
    for (const [topic, consumer] of this.consumers) {
      await consumer.run({
        eachMessage: async ({ topic, partition, message }) => {
          try {
            await callback({
              topic,
              partition,
              offset: message.offset,
              value: message.value.toString(),
              timestamp: message.timestamp,
            });
          } catch (error) {
            logger.error(`Error processing message from topic ${topic}:`, error);
          }
        },
      });
      logger.info(`Started consuming from topic: ${topic}`);
    }
  }

  async disconnect() {
    try {
      for (const [topic, consumer] of this.consumers) {
        await consumer.disconnect();
        logger.info(`Disconnected from topic: ${topic}`);
      }
    } catch (error) {
      logger.error('Error disconnecting from Kafka:', error);
      throw error;
    }
  }

  async gracefulShutdown() {
    logger.info('Initiating graceful shutdown...');
    try {
      await this.disconnect();
      logger.info('Graceful shutdown completed');
    } catch (error) {
      logger.error('Error during graceful shutdown:', error);
      process.exit(1);
    }
  }
}

module.exports = KafkaManager; 