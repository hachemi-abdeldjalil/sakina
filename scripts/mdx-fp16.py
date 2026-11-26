# Stores UVR-MDX-NET's weights as float16 (half the download) while it still computes in float32:
# every float32 weight becomes a float16 initializer plus a Cast back to float32. ONNX Runtime folds
# those Casts when it loads the model, so speed is unchanged.
#   python3 scripts/mdx-fp16.py models/UVR_MDXNET_1_9703.onnx models/mdx-vocals.fp16w.onnx
# Needs: pip install onnx numpy
import sys
import numpy as np
import onnx
from onnx import helper, numpy_helper, TensorProto

src, dst = sys.argv[1], sys.argv[2]
m = onnx.load(src)
g = m.graph
casts, keep = [], []
for init in g.initializer:
    if init.data_type == TensorProto.FLOAT and np.prod(init.dims) >= 16:  # leave tiny constants alone
        w = numpy_helper.to_array(init)
        half = numpy_helper.from_array(w.astype(np.float16), init.name + '__fp16')
        keep.append(half)
        casts.append(helper.make_node('Cast', [half.name], [init.name], to=TensorProto.FLOAT, name=init.name + '__cast'))
    else:
        keep.append(init)
del g.initializer[:]
g.initializer.extend(keep)
nodes = list(g.node)
del g.node[:]
g.node.extend(casts + nodes)
onnx.checker.check_model(m)
onnx.save(m, dst)
print(f'{dst}: {len(casts)} weights stored as float16')
