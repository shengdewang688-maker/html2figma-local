export type Viewport = {
  width: number;
  height: number;
  deviceScaleFactor?: number;
};

export type StateAction = {
  id: string;
  url?: string;
  from?: string;
  click?: string;
  hover?: string;
  fill?: Record<string, string>;
  press?: string;
  waitFor?: number;
  readySelector?: string;
  /** Keep this explicitly configured state even when its semantic page signature matches an earlier state. */
  capture?: "always";
};

export type StateOrigin = "explicit" | "auto" | "recorded";

export type StateOperation = {
  kind: "navigate" | "click" | "input" | "select" | "key" | "submit" | "route" | "snapshot";
  label?: string;
  selector?: string;
  value?: string;
  url?: string;
  at?: string;
};

export type StatePath = {
  id: string;
  origin: StateOrigin;
  operations: StateOperation[];
  capturedAt: string;
};

export type CandidateOutcome = {
  action: string;
  status: "captured" | "duplicate" | "skipped" | "unchanged" | "failed" | "timeout";
  reason?: string;
  stateId?: string;
};

export type StateCoverage = {
  captured: number;
  auto: number;
  recorded: number;
  duplicates: number;
  outcomes: CandidateOutcome[];
};

export type DiscoveryConfig = {
  include: string[];
  exclude: string[];
  maxDepth: number;
  maxAutoStates?: number;
  maxCandidatesPerState?: number;
  clickWaitFor?: number;
  clickTimeout?: number;
  maxModalActionsPerPath?: number;
  maxPageActionsPerPath?: number;
  inventoryExtraStates?: number;
  maxEmptyExpansions?: number;
  skipTextPatterns?: string[];
};

export type OutputConfig = {
  mode: "new-version-page";
  pageName: string;
};

export type Html2FigmaConfig = {
  input: string;
  sourceRoot?: string;
  figmaUrl?: string;
  viewport: Viewport;
  states: StateAction[];
  discovery: DiscoveryConfig;
  output: OutputConfig;
  readySelector?: string;
  navigationTimeout?: number;
  resourceTimeout?: number;
  serverPort?: number;
};

export type CliOptions = {
  input?: string;
  figmaUrl?: string;
  config?: string;
  out: string;
  port: number;
  appPort?: number;
  server?: boolean;
  noServer?: boolean;
  noBrowser?: boolean;
};

export type SceneNodeKind = "FRAME" | "TEXT" | "IMAGE" | "VECTOR" | "RASTER_FALLBACK";

export type Paint = {
  type: "SOLID";
  color: string;
  opacity?: number;
};

export type SceneStyle = {
  display?: string;
  layoutMode?: "HORIZONTAL" | "VERTICAL" | "NONE";
  gap?: number;
  padding?: { top: number; right: number; bottom: number; left: number };
  background?: string;
  backgroundOpacity?: number;
  color?: string;
  colorOpacity?: number;
  opacity?: number;
  borderColor?: string;
  borderOpacity?: number;
  borderWidth?: number;
  borderRadius?: number;
  boxShadow?: string;
  overflowX?: string;
  overflowY?: string;
  clipsContent?: boolean;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string;
  lineHeight?: number;
  letterSpacing?: number;
  textAlign?: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED";
  whiteSpace?: string;
  wordBreak?: string;
  overflowWrap?: string;
  textOverflow?: string;
  objectFit?: "FILL" | "FIT" | "CROP";
};

export type SceneNode = {
  id: string;
  kind: SceneNodeKind;
  name: string;
  tag?: string;
  rect: { x: number; y: number; width: number; height: number };
  zIndex?: number;
  sourceOrder?: number;
  text?: string;
  assetId?: string;
  svg?: string;
  style: SceneStyle;
  children: SceneNode[];
  editable: boolean;
  warnings: string[];
};

export type Asset = {
  id: string;
  kind: "image" | "raster" | "svg";
  source: string;
  mimeType: string;
  dataUrl?: string;
  width?: number;
  height?: number;
  warnings: string[];
};

export type CapturedState = {
  id: string;
  route: string;
  title: string;
  viewport: Viewport;
  domHash: string;
  capturedAt: string;
  screenshotPath: string;
  root: SceneNode;
  assets: Asset[];
  warnings: string[];
  origin?: StateOrigin;
  paths?: StatePath[];
  pageHash?: string;
  displayName?: string;
};

export type ConversionBundle = {
  version: 1;
  source: {
    input: string;
    figmaUrl?: string;
    capturedAt: string;
  };
  output: OutputConfig;
  states: CapturedState[];
  report: ConversionReport;
};

export type ConversionReport = {
  stateCount: number;
  assetCount: number;
  rasterFallbackCount: number;
  warnings: string[];
  coverage?: StateCoverage;
  states: Array<{
    id: string;
    route: string;
    domHash: string;
    nodeCount: number;
    assetCount: number;
    rasterFallbackCount: number;
    screenshotPath: string;
    warnings: string[];
    origin?: StateOrigin;
    displayName?: string;
    pathCount?: number;
  }>;
};
