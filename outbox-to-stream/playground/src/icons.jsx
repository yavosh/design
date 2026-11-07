const sources = import.meta.glob("./icons/*.svg", { query: "?raw", import: "default", eager: true });

function icon(name) {
  return function LibraryIcon({ size = 24, stroke = 2, className = "" }) {
    return <span aria-hidden="true" className={`library-icon ${className}`}
      style={{ width: size, height: size, "--icon-stroke": stroke }}
      dangerouslySetInnerHTML={{ __html: sources[`./icons/${name}.svg`] }} />;
  };
}

export const IconArrowDown = icon("arrow-down");
export const IconArrowRight = icon("arrow-right");
export const IconBolt = icon("bolt");
export const IconChartBar = icon("chart-bar");
export const IconCheck = icon("check");
export const IconCircle = icon("circle");
export const IconCircleCheck = icon("circle-check");
export const IconClock = icon("clock");
export const IconCube = icon("cube");
export const IconDatabase = icon("database");
export const IconFileDescription = icon("file-description");
export const IconInfoCircle = icon("info-circle");
export const IconPlayerPause = icon("player-pause");
export const IconPlayerPlay = icon("player-play");
export const IconRotateClockwise = icon("rotate-clockwise");
export const IconSettings = icon("settings");
export const IconShieldCheck = icon("shield-check");
export const IconX = icon("x");
