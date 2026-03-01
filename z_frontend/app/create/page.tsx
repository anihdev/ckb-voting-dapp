'use client';
  
  import { useState } from 'react';
  import { createPoll } from '../../lib/voting-api';
  import { Button } from '../../components/ui/Button';
  import { useRouter } from 'next/navigation';
  
  export default function CreatePollPage() {
    const router = useRouter();
    const [question, setQuestion] = useState('');
    const [deadline, setDeadline] = useState('');
    const [loading, setLoading] = useState(false);
    
    async function handleSubmit(e: React.FormEvent) {
      e.preventDefault();
      setLoading(true);
      
      try {
        const deadlineTimestamp = new Date(deadline).getTime();
        const txHash = await createPoll(question, deadlineTimestamp, walletAddress);
        
        alert(`Poll created! Tx: ${txHash}`);
        router.push('/');
      } catch (error) {
        alert(`Error: ${error.message}`);
      } finally {
        setLoading(false);
      }
    }
    
    return (
      <main className="container mx-auto p-4 max-w-2xl">
        <h1 className="text-3xl font-bold mb-8">Create New Poll</h1>
        
        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label className="block text-sm font-medium mb-2">Question</label>
            <input
              type="text"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              className="w-full border rounded p-2"
              placeholder="Should we adopt CKB?"
              required
            />
          </div>
          
          <div>
            <label className="block text-sm font-medium mb-2">Deadline</label>
            <input
              type="datetime-local"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
              className="w-full border rounded p-2"
              required
            />
          </div>
          
          <Button type="submit" disabled={loading}>
            {loading ? 'Creating...' : 'Create Poll'}
          </Button>
        </form>
      </main>
    );
  }