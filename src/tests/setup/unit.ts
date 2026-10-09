/**
 * Unit test setup.
 *
 * Loads .env so that `env()` does not throw at import time, and forces NODE_ENV
 * to 'test' so code that branches on it takes the test path.
 */
import 'dotenv/config';

// Index access rather than dot access: @types/node declares NODE_ENV readonly.
