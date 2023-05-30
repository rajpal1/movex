import { useMovexResource } from 'movex-react';
import { initialState } from '../../modules/rock-paper-scissors/rockPaperScissors.movex';
import movexConfig from 'apps/movex-demo/movex.config';

type Props = {};

export const PlayRPSButton: React.FC<Props> = () => {
  const rpsResource = useMovexResource(movexConfig, 'rps');

  if (!rpsResource) {
    return null;
  }

  return (
    <div>
      <button
        onClick={() => {
          rpsResource.create(initialState).map((item) => {
            window.location.href = window.location.origin + `/rps/${item.id}`;
          });
        }}
      >
        Play Rock Paper Scissors
      </button>
    </div>
  );
};