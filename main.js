import * as THREE from 'three';
import { GPUComputationRenderer } from 'three/addons/misc/GPUComputationRenderer.js';
import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import ThreeToCesium from './three-to-cesium.js';

/* =========================
   CESIUM
========================= */

Cesium.Ion.defaultAccessToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiIzOTUwYzYxZS0xNmQzLTRjYzQtYTE5NC1iMzNkNmZmNDJjODMiLCJpZCI6MzUwMjQsImlhdCI6MTYwMTI1NjYyNH0.qtYYRNJyDZB9yOcJG-e8UCwp2CeSMwYNMHDsbsebX9Y";

let cesiumViewer = new Cesium.Viewer('cesium-container', {
    // terrain: Cesium.Terrain.fromWorldTerrain(),
    animation: false,
    sceneModePicker: false,
    timeline: false
});

cesiumViewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(
        140.5,    // longitude
        35.2,     // latitude
        300_000   // 300 km altitude
    ),
    orientation: {
        heading: null,
        pitch: null,
        roll: 0,
    },
});

const options = {
    cameraNear: 10000,
    cameraFar: 50_000_000
};
const sceneIntegrator = ThreeToCesium(cesiumViewer, options);
const position = Cesium.Cartesian3.fromDegrees(
    140.95,   // longitude
    35.15,    // latitude
    300       // 300 m trên mặt biển
);


/* =========================
   THREE.JS
========================= */

// Texture width for simulation
const WIDTH = 128;

// Water size in system units
const BOUNDS = 110_000;

let tmpHeightmap = null;
let container;
let group;
let waterMesh;
let meshRay;
let gpuCompute;
let heightmapVariable;
let readWaterLevelShader;
let autoWaveActive = false;
let frame = 0;
let wavePhase = 0;

const simplex = new SimplexNoise();

const effectController = {
    mouseSize: 5,
    mouseDeep: 0.05,
    viscosity: 0.93,
    speed: 6,
    wireframe: false
};

init();

async function init() {

    group = new THREE.Group();
    sceneIntegrator.add(group, position);

    container = sceneIntegrator.threeRenderer.domElement.parentElement;
    container.style.touchAction = 'none';

    const hdrLoader = new HDRLoader().setPath('./libs/three/examples/textures/equirectangular/');
    const env = await hdrLoader.loadAsync('blouberg_sunrise_2_1k.hdr');
    env.mapping = THREE.EquirectangularReflectionMapping;

    sceneIntegrator.threeScene.environment = env;
    sceneIntegrator.threeScene.environmentIntensity = 1.25;

    initWater();

    sceneIntegrator.threeRenderer.setAnimationLoop(animate);

    window.addEventListener('resize', onWindowResize);

    // Auto wave trigger with interval 1 second
    window.setInterval(triggerAutoWave, 1000);

    cesiumViewer.scene.postRender.addEventListener(() => {
        sceneIntegrator.update();
    });

}

function initWater() {

    const geometry = new THREE.PlaneGeometry(BOUNDS * 1.5, BOUNDS, WIDTH - 1, WIDTH - 1);

    const material = new WaterMaterial({
        // color: 0x9bd2ec, //default color (light blue)
        color: 0x1D546C,
        metalness: 0.9,
        roughness: 0,
        transparent: true,
        opacity: 0.85,
        side: THREE.FrontSide
    });

    waterMesh = new THREE.Mesh(geometry, material);
    waterMesh.rotation.x = - Math.PI / 2;
    waterMesh.matrixAutoUpdate = false;
    waterMesh.receiveShadow = true;
    waterMesh.castShadow = true;
    waterMesh.updateMatrix();

    group.add(waterMesh);

    // THREE.Mesh just for mouse raycasting
    const geometryRay = new THREE.PlaneGeometry(BOUNDS, BOUNDS, 1, 1);
    meshRay = new THREE.Mesh(geometryRay, new THREE.MeshBasicMaterial({ color: 0xFFFFFF, visible: false }));
    meshRay.rotation.x = - Math.PI / 2;
    meshRay.matrixAutoUpdate = false;
    meshRay.updateMatrix();

    group.add(meshRay);

    // Creates the gpu computation class and sets it up
    gpuCompute = new GPUComputationRenderer(WIDTH, WIDTH, sceneIntegrator.threeRenderer);

    const heightmap0 = gpuCompute.createTexture();

    fillTexture(heightmap0);

    heightmapVariable = gpuCompute.addVariable('heightmap', shaderChange.heightmap_frag, heightmap0);

    gpuCompute.setVariableDependencies(heightmapVariable, [heightmapVariable]);

    heightmapVariable.material.uniforms['mousePos'] = { value: new THREE.Vector2(10000, 10000) };
    heightmapVariable.material.uniforms['mouseSize'] = { value: 5 };
    heightmapVariable.material.uniforms['viscosity'] = { value: 0.93 };
    heightmapVariable.material.uniforms['deep'] = { value: 0.05 };
    heightmapVariable.material.defines.BOUNDS = BOUNDS.toFixed(1);

    const error = gpuCompute.init();
    if (error !== null) console.error(error);

    // Create compute shader to read water level
    readWaterLevelShader = gpuCompute.createShaderMaterial(document.getElementById('readWaterLevelFragmentShader').textContent, {
        point1: { value: new THREE.Vector2() },
        levelTexture: { value: null }
    });
    readWaterLevelShader.defines.WIDTH = WIDTH.toFixed(1);
    readWaterLevelShader.defines.BOUNDS = BOUNDS.toFixed(1);

    sceneIntegrator.threeRenderer.shadowMap.enabled = true;
    group.rotation.x = 0.5 * Math.PI;

}

function fillTexture(texture) {

    const waterMaxHeight = 0.2;

    function noise(x, y) {

        let multR = waterMaxHeight;
        let mult = 0.025;
        let r = 0;
        for (let i = 0; i < 15; i++) {

            r += multR * simplex.noise(x * mult, y * mult);
            multR *= 0.53 + 0.025 * i;
            mult *= 1.25;

        }

        return r;

    }

    const pixels = texture.image.data;

    let p = 0;
    for (let j = 0; j < WIDTH; j++) {

        for (let i = 0; i < WIDTH; i++) {

            const x = i * 128 / WIDTH;
            const y = j * 128 / WIDTH;

            pixels[p + 0] = noise(x, y);
            pixels[p + 1] = pixels[p + 0];
            pixels[p + 2] = 0;
            pixels[p + 3] = 1;

            p += 4;

        }

    }

}

function onWindowResize() {

    let width = cesiumViewer.container.offsetWidth;
    let height = cesiumViewer.container.offsetHeight;
    sceneIntegrator.threeCamera.aspect = width / height;
    sceneIntegrator.threeCamera.updateProjectionMatrix();
    sceneIntegrator.threeRenderer.setSize(width, height);

}

function animate() {

    render();

}

function render() {

    frame++;

    if (frame >= 7 - effectController.speed) {

        // Do the gpu computation
        gpuCompute.compute();
        tmpHeightmap = gpuCompute.getCurrentRenderTarget(heightmapVariable).texture;

        // Get compute output in custom uniform
        if (waterMesh) waterMesh.material.heightmap = tmpHeightmap;

        frame = 0;

    }

}

// Tự động tạo sóng lan truyền từ góc dưới bên phải lên góc trên bên trái
function triggerAutoWave() {

    if (!heightmapVariable?.material?.uniforms || autoWaveActive) return;

    const u = heightmapVariable.material.uniforms;

    const halfX = (BOUNDS * 1.5) * 0.5;
    const halfZ = BOUNDS * 0.5;

    const start = new THREE.Vector2(+halfX, +halfZ);   // bottom-right
    const end = new THREE.Vector2(-halfX, -halfZ);     // top-left

    wavePhase += 0.06;
    if (wavePhase > 1) wavePhase = 0;

    const pos = start.clone().lerp(end, wavePhase);

    // Lưu giá trị cũ để restore
    const oldDeep = u.deep.value;
    const oldSize = u.mouseSize.value;

    autoWaveActive = true;

    // Pulse mạnh hơn để nhìn thấy rõ
    u.mouseSize.value = 5000;   // Bán kính tác động rõ ràng
    u.deep.value = 300;         // Lực đủ mạnh để thấy ngay
    u.mousePos.value.copy(pos);

    // Giữ 200ms cho GPU compute ăn vài frame
    setTimeout(() => {
        u.mousePos.value.set(10000, 10000);
        u.deep.value = oldDeep;
        u.mouseSize.value = oldSize;
        autoWaveActive = false;
    }, 200);
}


//----------------------

class WaterMaterial extends THREE.MeshStandardMaterial {

    constructor(parameters) {

        super();

        this.defines = {

            'STANDARD': '',
            'USE_UV': '',
            'WIDTH': WIDTH.toFixed(1),
            'BOUNDS': BOUNDS.toFixed(1),

        };

        this.extra = {};

        this.addParameter('heightmap', null);

        this.setValues(parameters);

    }

    addParameter(name, value) {

        this.extra[name] = value;
        Object.defineProperty(this, name, {
            get: () => (this.extra[name]),
            set: (v) => {

                this.extra[name] = v;
                if (this.userData.shader) this.userData.shader.uniforms[name].value = this.extra[name];

            }
        });

    }

    onBeforeCompile(shader) {

        for (const name in this.extra) {

            shader.uniforms[name] = { value: this.extra[name] };

        }

        shader.vertexShader = shader.vertexShader.replace('#include <common>', shaderChange.common);
        shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>', shaderChange.beginnormal_vertex);
        shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', shaderChange.begin_vertex);

        this.userData.shader = shader;

    }

}

const shaderChange = {

    heightmap_frag: /* glsl */`
        #include <common>

        uniform vec2 mousePos;
        uniform float mouseSize;
        uniform float viscosity;
        uniform float deep;

        void main()	{

            vec2 cellSize = 1.0 / resolution.xy;

            vec2 uv = gl_FragCoord.xy * cellSize;

            vec4 heightmapValue = texture2D( heightmap, uv );

            // Get neighbours
            vec4 north = texture2D( heightmap, uv + vec2( 0.0, cellSize.y ) );
            vec4 south = texture2D( heightmap, uv + vec2( 0.0, - cellSize.y ) );
            vec4 east = texture2D( heightmap, uv + vec2( cellSize.x, 0.0 ) );
            vec4 west = texture2D( heightmap, uv + vec2( - cellSize.x, 0.0 ) );

            float newHeight = ( ( north.x + south.x + east.x + west.x ) * 0.5 - (heightmapValue.y) ) * viscosity;


            // Mouse influence
            float mousePhase = clamp( length( ( uv - vec2( 0.5 ) ) * BOUNDS - vec2( mousePos.x, - mousePos.y ) ) * PI / mouseSize, 0.0, PI );
            newHeight -= ( cos( mousePhase ) + 1.0 ) * deep;

            heightmapValue.y = heightmapValue.x;
            heightmapValue.x = newHeight;

            gl_FragColor = heightmapValue;

        }
    `,
    // FOR MATERIAL
    common: /* glsl */`
        #include <common>
        uniform sampler2D heightmap;
    `,
    beginnormal_vertex: /* glsl */`
        vec2 cellSize = vec2( 1.0 / WIDTH, 1.0 / WIDTH );
        vec3 objectNormal = vec3(
        ( texture2D( heightmap, uv + vec2( - cellSize.x, 0 ) ).x - texture2D( heightmap, uv + vec2( cellSize.x, 0 ) ).x ) * WIDTH / BOUNDS,
        ( texture2D( heightmap, uv + vec2( 0, - cellSize.y ) ).x - texture2D( heightmap, uv + vec2( 0, cellSize.y ) ).x ) * WIDTH / BOUNDS,
        1.0 );
        #ifdef USE_TANGENT
            vec3 objectTangent = vec3( tangent.xyz );
        #endif
    `,
    begin_vertex: /* glsl */`
        float heightValue = texture2D( heightmap, uv ).x;
        vec3 transformed = vec3( position.x, position.y, heightValue );
        #ifdef USE_ALPHAHASH
            vPosition = vec3( position );
        #endif
    `,
};
