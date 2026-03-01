import Link from 'next/link';
  import { Card } from '../ui/Card';
  import { Poll } from '../../types';
  import { formatDistance } from 'date-fns';
  
  interface PollCardProps {
    poll: Poll;
  }
  
  export function PollCard({ poll }: PollCardProps) {
    const totalVotes = poll.yesCount + poll.noCount;
    const yesPercent = totalVotes > 0 ? (poll.yesCount / totalVotes) * 100 : 0;
    
    return (
      <Link href={`/vote/${poll.id}`}>
        <Card className="hover:shadow-lg transition cursor-pointer">
          <h3 className="text-xl font-semibold mb-2">{poll.question}</h3>
          
          <div className="mb-4">
            <div className="flex justify-between text-sm text-gray-600 mb-1">
              <span>Yes: {poll.yesCount}</span>
              <span>No: {poll.noCount}</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div 
                className="bg-green-500 h-2 rounded-full" 
                style={{ width: `${yesPercent}%` }}
              />
            </div>
          </div>
          
          <div className="text-sm text-gray-500">
            {poll.status === 'active' ? (
              <span>Ends {formatDistance(poll.deadline, Date.now(), { addSuffix: true })}</span>
            ) : (
              <span className="text-red-500">Closed</span>
            )}
          </div>
        </Card>
      </Link>
    );
  }