import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();
const prisma = new PrismaClient();

// Middleware
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || 'http://localhost:5173',
  credentials: true
}));
app.use(express.json());

// Health check route
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV
  });
});

// API info route
app.get('/api/info', (req, res) => {
  res.json({
    name: 'Hack Aggregator API',
    version: '0.0.1',
    environment: process.env.NODE_ENV,
    uptime: process.uptime()
  });
});

// Database connection test
app.get('/api/db-test', async (req, res) => {
  try {
    const result = await prisma.$queryRaw`SELECT NOW()`;
    res.json({
      status: 'Database connected',
      timestamp: result
    });
  } catch (error) {
    res.status(500).json({
      error: 'Database connection failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Route not found',
    path: req.path,
    method: req.method
  });
});

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`📊 Database test: http://localhost:${PORT}/api/db-test`);
  console.log(`💚 Health check: http://localhost:${PORT}/health`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n⏹️  Shutting down gracefully...');
  await prisma.$disconnect();
  process.exit(0);
});
