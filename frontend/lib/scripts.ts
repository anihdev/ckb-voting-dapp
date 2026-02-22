import scriptsJson from '../deployment/scripts.json';
  
  export const VOTING_SCRIPT = scriptsJson['voting-script.bc'];
  
  export function getVotingScript() {
    return {
      codeHash: VOTING_SCRIPT.codeHash,
      hashType: VOTING_SCRIPT.hashType as 'type' | 'data',
      args: '0x'
    };
  }