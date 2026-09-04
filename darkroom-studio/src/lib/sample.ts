export async function createSampleFile(): Promise<File> {
  const width = 1800;
  const height = 1200;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false })!;

  const sky = context.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, "#536b86");
  sky.addColorStop(0.38, "#a7a9a8");
  sky.addColorStop(0.64, "#d19a70");
  sky.addColorStop(1, "#39332f");
  context.fillStyle = sky;
  context.fillRect(0, 0, width, height);

  const sun = context.createRadialGradient(1280, 400, 0, 1280, 400, 430);
  sun.addColorStop(0, "rgba(255,224,169,.72)");
  sun.addColorStop(0.2, "rgba(250,188,123,.22)");
  sun.addColorStop(1, "rgba(229,151,102,0)");
  context.fillStyle = sun;
  context.fillRect(760, 0, 1040, 900);

  const ridge = (
    points: [number, number][],
    fill: string,
    blur = 0,
  ) => {
    context.save();
    context.filter = blur ? `blur(${blur}px)` : "none";
    context.beginPath();
    context.moveTo(points[0][0], points[0][1]);
    points.slice(1).forEach(([x, y]) => context.lineTo(x, y));
    context.lineTo(width, height);
    context.lineTo(0, height);
    context.closePath();
    context.fillStyle = fill;
    context.fill();
    context.restore();
  };

  ridge(
    [
      [0, 700],
      [210, 540],
      [390, 672],
      [610, 452],
      [870, 656],
      [1060, 515],
      [1280, 650],
      [1470, 492],
      [1800, 670],
    ],
    "rgba(55,61,65,.58)",
    2,
  );
  ridge(
    [
      [0, 820],
      [250, 690],
      [480, 770],
      [720, 610],
      [920, 790],
      [1180, 635],
      [1430, 746],
      [1650, 608],
      [1800, 700],
    ],
    "#293238",
  );
  ridge(
    [
      [0, 910],
      [230, 850],
      [470, 914],
      [700, 798],
      [900, 920],
      [1160, 810],
      [1380, 925],
      [1580, 790],
      [1800, 900],
    ],
    "#171d20",
  );

  context.fillStyle = "#0f1315";
  context.fillRect(0, 1000, width, 200);
  for (let x = 0; x < width; x += 28 + Math.random() * 42) {
    const treeHeight = 65 + Math.random() * 125;
    context.beginPath();
    context.moveTo(x, 1030);
    context.lineTo(x + 10, 1030 - treeHeight);
    context.lineTo(x + 24, 1030);
    context.fill();
  }

  const image = context.getImageData(0, 0, width, height);
  const pixels = image.data;
  for (let index = 0; index < pixels.length; index += 4) {
    const noise = (Math.random() - 0.5) * 7;
    pixels[index] = Math.max(0, Math.min(255, pixels[index] + noise));
    pixels[index + 1] = Math.max(0, Math.min(255, pixels[index + 1] + noise));
    pixels[index + 2] = Math.max(0, Math.min(255, pixels[index + 2] + noise));
  }
  context.putImageData(image, 0, 0);

  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (result) => (result ? resolve(result) : reject(new Error("Could not create sample image."))),
      "image/jpeg",
      0.92,
    ),
  );
  return new File([blob], "Darkroom_sample_twilight.jpg", {
    type: "image/jpeg",
    lastModified: Date.now(),
  });
}
