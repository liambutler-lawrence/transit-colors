"""Optional native HiGHS backend for offline continental area optimization."""

import json
import sys

import highspy
import numpy as np

model_path, output_path, seconds = sys.argv[1:4]
solver = highspy.Highs()
solver.readModel(model_path)
solver.setOptionValue("log_file", model_path + ".progress.log")
solver.setOptionValue("time_limit", float(seconds))
solver.setOptionValue("mip_rel_gap", 0.0)
solver.setOptionValue("mip_abs_gap", 0.000001)
solver.setOptionValue("threads", 4)
if len(sys.argv) > 4:
    columns = json.load(open(sys.argv[4], encoding="utf-8"))
    names = solver.getLp().col_names_
    values = np.array([columns.get(name, {}).get("Primal", 0) for name in names])
    solver.setSolution(len(names), np.arange(len(names), dtype=np.int32), values)
solver.run()
model = solver.getLp()
solution = solver.getSolution()
info = solver.getInfo()
with open(output_path, "w", encoding="utf-8") as output:
    json.dump(
        {
            "Status": solver.modelStatusToString(solver.getModelStatus()),
            "ObjectiveValue": info.objective_function_value,
            "ObjectiveBound": info.mip_dual_bound,
            "Columns": {
                name: {"Primal": float(value)}
                for name, value in zip(model.col_names_, solution.col_value)
                if value != 0
            },
        },
        output,
    )
