import { createContext, useContext, useState, ReactNode } from 'react';

interface RecordingCtx {
  selectedRecordingId: number | null;
  setSelectedRecordingId: (id: number | null) => void;
}

const RecordingContext = createContext<RecordingCtx>({
  selectedRecordingId: null,
  setSelectedRecordingId: () => {},
});

export const useSelectedRecording = () => useContext(RecordingContext);

export function RecordingProvider({ children }: { children: ReactNode }) {
  const [selectedRecordingId, setSelectedRecordingId] = useState<number | null>(null);
  return (
    <RecordingContext.Provider value={{ selectedRecordingId, setSelectedRecordingId }}>
      {children}
    </RecordingContext.Provider>
  );
}
