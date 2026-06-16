export class SkillMarketConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillMarketConfigError';
  }
}

export class SkillMarketCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillMarketCatalogError';
  }
}

export class SkillMarketNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillMarketNotFoundError';
  }
}

export class SkillMarketValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillMarketValidationError';
  }
}
