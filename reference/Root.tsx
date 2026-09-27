import React from 'react';
import {Composition} from 'remotion';
import {ChipExplainer} from './Video';
import T from './timeline.json';

export const Root: React.FC = () => (
  <Composition id="ChipExplainer" component={ChipExplainer} durationInFrames={T.duration * T.fps} fps={T.fps} width={1920} height={1080} />
);
