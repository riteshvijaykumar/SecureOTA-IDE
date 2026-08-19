import { GitHubIntegration } from './github-integration';

export interface UploadSketchOptions {
  sketchPath: string;
  binPath: string;
  sketchName: string;
  devicePort?: string;
}

export class UploadSketchContribution {
  constructor(private readonly gitHubIntegration: GitHubIntegration) {}

  async uploadSketch(options: UploadSketchOptions): Promise<void> {
    await this.simulateUpload(options);
    await this.gitHubIntegration.triggerRelease(options);
  }

  private async simulateUpload(_options: UploadSketchOptions): Promise<void> {
    return Promise.resolve();
  }
}
