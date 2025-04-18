import { useKrispNoiseFilter } from '@livekit/components-react/krisp';

function MyKrispSetting() {
  const krisp = useKrispNoiseFilter();
  return (
    <input
      type="checkbox"
      onChange={(ev) => krisp.setNoiseFilterEnabled(ev.target.checked)}
      checked={krisp.isNoiseFilterEnabled}
      disabled={krisp.isNoiseFilterPending}
    />
  );
}

export default MyKrispSetting;
