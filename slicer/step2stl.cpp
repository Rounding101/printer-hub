// STEP -> binary STL with OpenCASCADE, meshed the way OrcaSlicer's GUI does
// (absolute linear deflection 0.003 mm, angular 0.5 rad). Orca's CLI can't
// read STEP itself, so the slicer service converts first.
//
//   step2stl <in.step> <out.stl> [linear_mm] [angle_rad]
//   step2stl --make-test <out.step>   (60x30x12 mm block with a 9 mm hole, for the build self-test)
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepPrimAPI_MakeCylinder.hxx>
#include <IFSelect_ReturnStatus.hxx>
#include <Interface_Static.hxx>
#include <STEPControl_Reader.hxx>
#include <STEPControl_Writer.hxx>
#include <StlAPI_Writer.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS_Shape.hxx>
#include <gp_Ax2.hxx>

#include <cstdio>
#include <cstdlib>
#include <cstring>

static int makeTest(const char *out) {
  TopoDS_Shape box = BRepPrimAPI_MakeBox(60, 30, 12).Shape();
  TopoDS_Shape hole = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(30, 15, -1), gp_Dir(0, 0, 1)), 9, 14).Shape();
  TopoDS_Shape part = BRepAlgoAPI_Cut(box, hole).Shape();
  STEPControl_Writer w;
  if (w.Transfer(part, STEPControl_AsIs) != IFSelect_RetDone || w.Write(out) != IFSelect_RetDone) {
    std::fprintf(stderr, "Couldn't write %s\n", out);
    return 1;
  }
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 3 && std::strcmp(argv[1], "--make-test") == 0) return makeTest(argv[2]);
  if (argc < 3) {
    std::fprintf(stderr, "usage: step2stl <in.step> <out.stl> [linear_mm] [angle_rad]\n");
    return 2;
  }
  const double linear = argc > 3 ? std::atof(argv[3]) : 0.003;
  const double angle = argc > 4 ? std::atof(argv[4]) : 0.5;

  Interface_Static::SetCVal("xstep.cascade.unit", "MM");
  STEPControl_Reader reader;
  if (reader.ReadFile(argv[1]) != IFSelect_RetDone) {
    std::fprintf(stderr, "STEP error: the file couldn't be read\n");
    return 3;
  }
  reader.TransferRoots();
  TopoDS_Shape shape = reader.OneShape();
  if (shape.IsNull() || !TopExp_Explorer(shape, TopAbs_FACE).More()) {
    std::fprintf(stderr, "STEP error: no solid or surface shapes in the file\n");
    return 4;
  }

  BRepMesh_IncrementalMesh mesh(shape, linear, Standard_False, angle, Standard_True);
  if (!mesh.IsDone()) {
    std::fprintf(stderr, "STEP error: meshing failed\n");
    return 5;
  }
  StlAPI_Writer writer;
  writer.ASCIIMode() = Standard_False;
  if (!writer.Write(shape, argv[2])) {
    std::fprintf(stderr, "STEP error: couldn't write the STL\n");
    return 6;
  }
  return 0;
}
