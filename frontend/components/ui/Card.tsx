interface CardProps {
    children: React.ReactNode;
    className?: string;
  }
  
  export function Card({ children, className = '' }: CardProps) {
    return (
      <div className={`border rounded-lg p-6 shadow-sm ${className}`}>
        {children}
      </div>
    );
  }