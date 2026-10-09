import 'dotenv/config';

// Index access rather than dot access: @types/node declares NODE_ENV readonly.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
