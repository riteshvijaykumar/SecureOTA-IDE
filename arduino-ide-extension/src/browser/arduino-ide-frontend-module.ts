import { ContainerModule } from 'inversify';
import { GitHubIntegration } from './contributions/github-integration';

export const secureotaFrontendModule = new ContainerModule((bind) => {
  bind(GitHubIntegration).toSelf().inSingletonScope();
});
