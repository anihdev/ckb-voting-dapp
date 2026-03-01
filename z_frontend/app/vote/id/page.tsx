'use client';
  
  import { useEffect, useState } from 'react';
  import { getPollById, castVote } from '../../../lib/voting-api';
  import { Poll } from '../../../types';
  import { Button } from '../../../components/ui/Button';
  
  export default function VotePage({ params }: { params: { id: string } }) {
    const [poll, setPoll] = useState<Poll | null>(null);
    const [loading, setLoading] = useState(false);
    
    useEffect(() => {
      loadPoll();
    }, [params.id]);
    
    async function loadPoll() {
      const data = await getPollById(params.id);
      setPoll(data);
    }
    
    async function handleVote(vote: boolean) {
      setLoading(true);
      try {
        const txHash = await castVote(params.id, vote, walletAddress);
        alert(`Vote cast! Tx: ${txHash}`);
        loadPoll(); // Refresh
      } catch (error) {
        alert(`Error: ${error.message}`);
      } finally {
        setLoading(false);
      }
    }
    
    if (!poll) return <div>Loading...</div>;
    
    return (
      <main className="container mx-auto p-4 max-w-2xl">
        <h1 className="text-3xl font-bold mb-8">{poll.question}</h1>
        
        <div className="space-y-4">
          <Button 
            onClick={() => handleVote(true)}
            disabled={loading || poll.status === 'closed'}
          >
            Vote Yes ({poll.yesCount})
          </Button>
          
          <Button 
            onClick={() => handleVote(false)}
            disabled={loading || poll.status === 'closed'}
            variant="secondary"
          >
            Vote No ({poll.noCount})
          </Button>
        </div>
        
        {poll.status === 'closed' && (
          <p className="mt-4 text-red-500">This poll is closed</p>
        )}
      </main>
    );
  }