/**
 * Runtime skills adapter contract.
 * Implementations must provide:
 *  - listSkills()
 *  - invoke(request)
 *  - getInvocation(invocationId)
 *  - cancelInvocation(invocationId)
 *  - health()
 */

export class SkillsAdapter {
  // eslint-disable-next-line no-unused-vars
  async listSkills(options = {}) {
    throw new Error('Not implemented');
  }

  async invoke(_request) {
    throw new Error('Not implemented');
  }

  async getInvocation(_invocationId) {
    throw new Error('Not implemented');
  }

  async cancelInvocation(_invocationId) {
    throw new Error('Not implemented');
  }

  async health() {
    throw new Error('Not implemented');
  }
}
