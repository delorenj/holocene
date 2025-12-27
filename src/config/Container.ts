/**
 * Dependency Injection Container
 * Simple IoC container for managing service dependencies
 */

type Constructor<T = unknown> = new (...args: unknown[]) => T;
type Factory<T = unknown> = () => T;
type ServiceDefinition<T = unknown> = Constructor<T> | Factory<T>;

export enum ServiceLifetime {
  SINGLETON = 'singleton',
  TRANSIENT = 'transient',
}

interface ServiceRegistration {
  definition: ServiceDefinition;
  lifetime: ServiceLifetime;
  instance?: unknown;
}

export class Container {
  private services: Map<string, ServiceRegistration> = new Map();

  /**
   * Register a service with the container
   */
  register<T>(
    name: string,
    definition: ServiceDefinition<T>,
    lifetime: ServiceLifetime = ServiceLifetime.SINGLETON
  ): void {
    this.services.set(name, {
      definition,
      lifetime,
      instance: undefined,
    });
  }

  /**
   * Register a singleton service
   */
  registerSingleton<T>(name: string, definition: ServiceDefinition<T>): void {
    this.register(name, definition, ServiceLifetime.SINGLETON);
  }

  /**
   * Register a transient service
   */
  registerTransient<T>(name: string, definition: ServiceDefinition<T>): void {
    this.register(name, definition, ServiceLifetime.TRANSIENT);
  }

  /**
   * Resolve a service from the container
   */
  resolve<T>(name: string): T {
    const registration = this.services.get(name);

    if (!registration) {
      throw new Error(`Service '${name}' not registered`);
    }

    // Return existing singleton instance
    if (
      registration.lifetime === ServiceLifetime.SINGLETON &&
      registration.instance
    ) {
      return registration.instance as T;
    }

    // Create new instance
    const instance = this.createInstance<T>(registration.definition);

    // Cache singleton instance
    if (registration.lifetime === ServiceLifetime.SINGLETON) {
      registration.instance = instance;
    }

    return instance;
  }

  /**
   * Check if a service is registered
   */
  has(name: string): boolean {
    return this.services.has(name);
  }

  /**
   * Clear all registered services
   */
  clear(): void {
    this.services.clear();
  }

  /**
   * Create instance from definition
   */
  private createInstance<T>(definition: ServiceDefinition<T>): T {
    if (typeof definition === 'function') {
      // Check if it's a constructor or factory
      if (definition.prototype) {
        // Constructor
        return new (definition as Constructor<T>)();
      } else {
        // Factory function
        return (definition as Factory<T>)();
      }
    }

    throw new Error('Invalid service definition');
  }
}

// Global container instance
export const container = new Container();
