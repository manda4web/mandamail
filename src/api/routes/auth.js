import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { UserRepo } from '../../db/repos/UserRepo.js';
import logger from '../../logger.js';

/**
 * Registers the authentication routes on the Fastify instance.
 * POST /auth/login — public endpoint, no authentication required.
 * @param {import('fastify').FastifyInstance} fastify
 */
export default async function authRoutes(fastify) {
  fastify.post('/auth/login', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const { email, password } = request.body;

    // Find user by email
    const user = await UserRepo.findByEmail(email);

    if (!user) {
      logger.warn({ email }, 'Login attempt for non-existent user');
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    // Compare password with bcrypt hash (cost factor >= 10)
    const isValid = await bcrypt.compare(password, user.password_hash);

    if (!isValid) {
      logger.warn({ email }, 'Login attempt with invalid password');
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    // Issue JWT with user payload
    const payload = { id: user.id, email: user.email, role: user.role };
    const expiresIn = process.env.JWT_EXPIRES_IN || '8h';

    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn });

    return reply.send({ token });
  });
}
