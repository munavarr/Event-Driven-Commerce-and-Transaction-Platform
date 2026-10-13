/**
 * Injection tokens shared by database consumers.
 *
 * Keep these in a dependency-free module. Importing a token from the module
 * that registers its provider creates an ESM circular dependency, which can
 * leave the token undefined while decorators are evaluated.
 */
export const KNEX = 'KNEX';
